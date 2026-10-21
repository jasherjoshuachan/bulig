# shellcheck shell=bash
# What "nothing but Bulig changed" means, as text. Source it after common.sh; do not run it.
# Bulig's own users, units, cluster and folders are filtered out of both snapshots, so a diff shows only changes to everything else
# that is listed here. Anything not listed here is NOT checked.

# Services that start and stop on their own schedule. They would make a diff fail for reasons that have nothing to do with Bulig.
SNAPSHOT_NOISE='^(apt-daily|apt-daily-upgrade|fwupd-refresh|motd-news|man-db|e2scrub|logrotate|sysstat|systemd-tmpfiles-clean|update-notifier|ua-timer|dpkg-db-backup|phpsessionclean|certbot|user@|user-runtime-dir@|sshd@|session-)'
# Names that are Bulig's: units, users, groups, files.
SNAPSHOT_OWN='^(bulig|postgresql@16-bulig)'

snapshot() {
  echo "## pg_lsclusters (the bulig cluster is left out)"
  if command -v pg_lsclusters >/dev/null 2>&1; then
    pg_lsclusters -h | awk -v c="$BULIG_PG_CLUSTER" -v p="$BULIG_PG_PORT" '!($2 == c && $3 == p) {print $1, $2, $3, $4, $5, $6}' | sort
  else
    echo "(no pg_lsclusters)"
  fi

  echo "## running services (Bulig's left out)"
  systemctl list-units --type=service --state=running --no-legend --plain --no-pager \
    | awk '{print $1}' | grep -Ev "$SNAPSHOT_OWN" | grep -Ev "$SNAPSHOT_NOISE" | sort || true

  echo "## every service unit and its state (Bulig's left out). This covers the other apps on the host, whatever they are called."
  systemctl list-units --type=service --all --no-legend --plain --no-pager \
    | awk '{print $1, $3, $4}' | grep -Ev "$SNAPSHOT_OWN" | grep -Ev "$SNAPSHOT_NOISE" | sort || true

  echo "## timers and what they start (Bulig's left out; next/last run times are not compared)"
  systemctl list-timers --all --no-legend --plain --no-pager \
    | grep -Eo '[^ ]+\.timer +[^ ]+\.service' | grep -Ev "$SNAPSHOT_OWN" | sort || true

  echo "## listening tcp sockets (Bulig's ports $BULIG_PG_PORT and $BULIG_GATEWAY_PORT left out; pids stripped)"
  ss -H -ltnp 2>/dev/null \
    | awk -v p=":($BULIG_PG_PORT|$BULIG_GATEWAY_PORT)\$" '{ addr = $4; proc = ($NF ~ /^users:/) ? $NF : "-"; if (addr !~ p) print addr, proc }' \
    | sed -E 's/pid=[0-9]+,?//g; s/,?fd=[0-9]+//g' | sort -u

  echo "## docker containers (name, image, state)"
  if command -v docker >/dev/null 2>&1; then
    docker ps -a --format '{{.Names}} {{.Image}} {{.State}}' 2>/dev/null | sort || true
  else
    echo "(no docker)"
  fi

  echo "## service unit files (state)"
  systemctl list-unit-files --type=service --no-legend --plain --no-pager | awk '{print $1, $2}' | grep -Ev "$SNAPSHOT_OWN" | sort || true

  # Bulig's own: any file or link whose name contains bulig, and anything whose first folder or file name under /etc/systemd/system starts with
  # bulig (bulig-worker.service.d/10-host-addresses.conf is a file called 10-host-addresses.conf inside a Bulig folder).
  echo "## /etc/systemd/system: file hashes and link targets (Bulig's own left out: names containing bulig, and everything under a bulig* name)"
  if [ -d "$R/etc/systemd/system" ]; then
    find "$R/etc/systemd/system" -type f -not -name '*bulig*' -not -path "$R/etc/systemd/system/bulig*" -print0 | sort -z | xargs -0 -r sha256sum
    # shellcheck disable=SC2016
    find "$R/etc/systemd/system" -type l -not -name '*bulig*' -not -path "$R/etc/systemd/system/bulig*" -print0 | sort -z | xargs -0 -r -n1 sh -c 'echo "$0 -> $(readlink "$0")"'
  fi

  echo "## postgresql config of the other clusters (sha256)"
  if [ -d "$R/etc/postgresql" ]; then
    find "$R/etc/postgresql" -type f -not -path "*/$BULIG_PG_VERSION/$BULIG_PG_CLUSTER/*" -print0 | sort -z | xargs -0 -r sha256sum
  fi

  echo "## users and groups (bulig and bulig-worker left out)"
  getent passwd | grep -Ev '^(bulig|bulig-worker):' | sort || true
  getent group | grep -Ev '^(bulig|bulig-worker):' | sort || true

  echo "## cron: root's crontab and /etc/cron.d (names containing bulig left out)"
  { crontab -l 2>/dev/null || echo "(no crontab)"; } | sha256sum
  if [ -d "$R/etc/cron.d" ]; then
    find "$R/etc/cron.d" -type f -not -name '*bulig*' -print0 | sort -z | xargs -0 -r sha256sum
  fi

  echo "## mode and owner of the folders Bulig works under"
  stat -c '%a %U %G %n' / /etc /tmp /opt /var/lib /var/backups /run 2>/dev/null || true
}

# ---- the baselines --------------------------------------------------------------------------------------------------------------
# precheck.snapshot: taken once, before Bulig was installed (precheck.sh). It stays: it is the baseline for removing Bulig (RUNBOOK).
# release-<sha>.before.snapshot: taken by every release just before it changes anything on the host (release-remote.sh), so the
# comparison after it covers that release only, not every other tenant's work since the precheck. The newest few are kept.
SNAPSHOT_RELEASE_KEEP=5
SNAPSHOT_RELEASE_RE='^release-[0-9a-f]{12}\.before\.snapshot$'

# snapshot_save <file>: a snapshot into <file> (inside /var/lib/bulig-checks), root-only (0600), whole or not at all.
# Call it where set -e holds (not inside an if or after ||), so any command in snapshot() that fails stops it. The temp file is
# SNAPSHOT_TMP, for the caller's EXIT trap to remove when that happens.
snapshot_save() {
  local out="$1"
  SNAPSHOT_TMP="$(mktemp "$BULIG_CHECKS_DIR/snapshot.XXXXXX")"
  snapshot >"$SNAPSHOT_TMP"
  chmod 600 "$SNAPSHOT_TMP"
  mv "$SNAPSHOT_TMP" "$out"
}

# snapshot_release_files: the release-before snapshots in /var/lib/bulig-checks, newest first (by time written), one name per line.
snapshot_release_files() {
  { ls -1t "$BULIG_CHECKS_DIR" 2>/dev/null || true; } | { grep -E "$SNAPSHOT_RELEASE_RE" || true; }
}

# snapshot_prune_releases: keep the newest $SNAPSHOT_RELEASE_KEEP release-before snapshots, remove the older ones. Nothing else.
snapshot_prune_releases() {
  local n=0 f
  while IFS= read -r f; do
    n=$((n + 1))
    [ "$n" -gt "$SNAPSHOT_RELEASE_KEEP" ] || continue
    rm -f "${BULIG_CHECKS_DIR:?}/$f"
  done < <(snapshot_release_files)
}

# ---- comparing two snapshots (postcheck.sh). It reads the format above as it is, so a precheck taken by an older kit still compares. ----
# Churn that Bulig cannot cause and that happens all the time is reported, not compared:
#   - the run state of a service a timer starts (a oneshot is "activating" mid-run, "inactive dead" after, "failed" if its own run failed).
#     Its unit file, its enabled state and the timer itself are still compared, in their own sections.
#   - transient units that systemd-run makes (run-u*.service, run-p*.service): they come, run and go. Any change to their lines is info.
#   - a template instance (name@instance.service) that is in one snapshot and not the other: an instance that appeared or went away.
#     One that is in both and changed state is still compared, and so is the template's unit file. (Another Postgres cluster's
#     postgresql@... instance is covered by the clusters section too, which is compared.)
#   - a new container from an image that was already running before (a per-session agent container), and a container that is gone or
#     stopped while its image still runs in another container. A new image, a container whose image no longer runs anywhere, or a known
#     container on a new image still fails.
# Bulig's own units are never in a snapshot (SNAPSHOT_OWN), and they are never counted as churn either.
SNAPSHOT_RUNSTATE_SECTIONS='^## (running services|every service unit and its state)'
SNAPSHOT_TIMER_SECTION='^## timers and what they start'
SNAPSHOT_DOCKER_SECTION='^## docker containers'
SNAPSHOT_UNITFILE_SECTION='^## service unit files'
SNAPSHOT_TRANSIENT='^run-[up][0-9][^ ]*\.service$'
SNAPSHOT_INSTANCE='^[^@ ]+@[^@ ]+\.service$'

# snapshot_section <file> <header regex>: the lines of that section, without its header.
snapshot_section() {
  awk -v h="$2" '/^## / { on = ($0 ~ h); next } on' "$1"
}

# timer_started <unit> <snapshot...>: true if a timer starts this service. Either snapshot's timers section says so, or systemd says the
# unit is TriggeredBy a .timer, or it is a oneshot and a .timer of the same name exists.
timer_started() {
  local u="$1" base="${1%.service}" f props
  shift
  for f in "$@"; do
    if snapshot_section "$f" "$SNAPSHOT_TIMER_SECTION" | awk -v u="$u" '$2 == u { found = 1 } END { exit !found }'; then return 0; fi
  done
  props="$(systemctl show -p TriggeredBy -p Type --no-pager "$u" 2>/dev/null || true)"
  if grep -Eq '^TriggeredBy=(.* )?[^ ]+\.timer( |$)' <<<"$props"; then return 0; fi
  if grep -qx 'Type=oneshot' <<<"$props"; then
    for f in "$@"; do
      if snapshot_section "$f" "$SNAPSHOT_TIMER_SECTION" | awk -v t="$base.timer" '$1 == t { found = 1 } END { exit !found }'; then return 0; fi
    done
    if [ -n "$(systemctl list-unit-files --no-legend --plain --no-pager "$base.timer" 2>/dev/null)" ]; then return 0; fi
  fi
  return 1
}

# snapshot_compare <before> <after> <before out> <after out>: write copies of both snapshots without the churn above, so a plain diff of
# the copies is the verdict, and print one info line per change left out (a warn line when a timer's service, a transient unit or an
# instance is failed now).
snapshot_compare() {
  local before="$1" after="$2" u b a what timed="" churn="" uf_churn="" new_ctrs=""
  # Services whose run-state lines differ: the ones a timer starts, then transient units, then template instances that came or went.
  for u in $(comm -3 <(snapshot_section "$before" "$SNAPSHOT_RUNSTATE_SECTIONS" | sort) <(snapshot_section "$after" "$SNAPSHOT_RUNSTATE_SECTIONS" | sort) | awk '{print $1}' | sort -u); do
    if grep -Eq "$SNAPSHOT_OWN" <<<"$u"; then continue; fi
    if timer_started "$u" "$before" "$after"; then
      timed="$timed $u"
    elif grep -Eq "$SNAPSHOT_TRANSIENT" <<<"$u"; then
      churn="$churn $u"
    elif grep -Eq "$SNAPSHOT_INSTANCE" <<<"$u" && ! { snapshot_has_unit "$before" "$u" && snapshot_has_unit "$after" "$u"; }; then
      churn="$churn $u"
    fi
  done
  for u in $timed; do
    b="$(snapshot_unit_state "$before" "$u")"
    a="$(snapshot_unit_state "$after" "$u")"
    [ "$b" != "$a" ] || continue
    case " $a " in
      *" failed "*) echo "warn  $u is failed now (${b:-not loaded} before). A timer starts it, so its run state is not compared, but its own run failed: look at it (systemctl status $u)." ;;
      *) echo "info  $u: ${b:-not loaded} -> ${a:-not loaded} (a timer starts it; its run state is not compared)" ;;
    esac
  done
  for u in $churn; do
    b="$(snapshot_unit_state "$before" "$u")"
    a="$(snapshot_unit_state "$after" "$u")"
    if grep -Eq "$SNAPSHOT_TRANSIENT" <<<"$u"; then what="a transient systemd-run unit"; else what="a template instance that came or went"; fi
    case " $a " in
      *" failed "*) echo "warn  $u is failed now (${b:-not loaded} before). It is $what, so it is not compared, but its own run failed: look at it (systemctl status $u)." ;;
      *) echo "info  $u: ${b:-not loaded} -> ${a:-not loaded} ($what; not compared)" ;;
    esac
  done
  # Transient units in the unit files list (state "transient") come and go with them.
  for u in $(comm -3 <(snapshot_section "$before" "$SNAPSHOT_UNITFILE_SECTION" | sort) <(snapshot_section "$after" "$SNAPSHOT_UNITFILE_SECTION" | sort) | awk '{print $1}' | sort -u); do
    if grep -Eq "$SNAPSHOT_OWN" <<<"$u" || ! grep -Eq "$SNAPSHOT_TRANSIENT" <<<"$u"; then continue; fi
    uf_churn="$uf_churn $u"
    case " $churn " in *" $u "*) ;; *) echo "info  $u: its unit file line changed (a transient systemd-run unit; not compared)" ;; esac
  done
  # Containers that come and go next to a long-lived one from the same image (per-session agent containers):
  #   new:  a container the precheck did not have, from an image that was running at the precheck;
  #   gone: a container the precheck had running that is gone (or stopped, same image) now, while its image still runs in another one.
  local kind name img
  while read -r kind name img; do
    [ -n "$name" ] || continue
    new_ctrs="$new_ctrs $name"
    case "$kind" in
      new) echo "info  new container $name from $img (that image was already running before; not compared)" ;;
      gone) echo "info  container $name from $img is gone now (that image still runs in another container; not compared)" ;;
      stopped) echo "info  container $name from $img is stopped now (that image still runs in another container; not compared)" ;;
    esac
  done < <(awk -v h="$SNAPSHOT_DOCKER_SECTION" '
      FNR == 1 { file++ }
      /^## / { on = ($0 ~ h); next }
      !on || NF < 3 { next }
      file == 1 { seen[$1] = 1; bimg[$1] = $2; bstate[$1] = $3; if ($3 == "running") running[$2] = 1; next }
      { now[$1] = 1; aimg[$1] = $2; astate[$1] = $3; if ($3 == "running") running_now[$2] = 1 }
      !($1 in seen) && ($2 in running) { print "new", $1, $2 }
      END {
        for (n in seen) {
          if (bstate[n] != "running" || !(bimg[n] in running_now)) continue
          if (!(n in now)) print "gone", n, bimg[n]
          else if (aimg[n] == bimg[n] && astate[n] != "running") print "stopped", n, bimg[n]
        }
      }' "$before" "$after")
  # The copies: the same lines minus those.
  snapshot_drop "$before" "$timed $churn" "$new_ctrs" "$uf_churn" >"$3"
  snapshot_drop "$after" "$timed $churn" "$new_ctrs" "$uf_churn" >"$4"
}

# snapshot_has_unit <file> <unit>: true if the unit is in that snapshot's run-state sections at all.
snapshot_has_unit() {
  snapshot_section "$1" "$SNAPSHOT_RUNSTATE_SECTIONS" | awk -v u="$2" '$1 == u { found = 1 } END { exit !found }'
}

# snapshot_unit_state <file> <unit>: its active and sub state in that snapshot ("active running"), or nothing when it is not there.
snapshot_unit_state() {
  snapshot_section "$1" '^## every service unit and its state' | awk -v u="$2" '$1 == u { print $2, $3; exit }'
}

# snapshot_drop <file> <services> <containers> <unit files>: the file without those services' run-state lines, those containers' lines
# and those unit files' lines.
snapshot_drop() {
  awk -v units=" $2 " -v ctrs=" $3 " -v ufs=" ${4:-} " -v rs="$SNAPSHOT_RUNSTATE_SECTIONS" -v dk="$SNAPSHOT_DOCKER_SECTION" -v uf="$SNAPSHOT_UNITFILE_SECTION" '
    /^## / { sec = ($0 ~ rs) ? "rs" : ($0 ~ dk) ? "dk" : ($0 ~ uf) ? "uf" : ""; print; next }
    sec == "rs" && index(units, " " $1 " ") { next }
    sec == "dk" && index(ctrs, " " $1 " ") { next }
    sec == "uf" && index(ufs, " " $1 " ") { next }
    { print }' "$1"
}
