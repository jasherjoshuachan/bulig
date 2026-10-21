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

# ---- comparing two snapshots (postcheck.sh). It reads the format above as it is, so a precheck taken by an older kit still compares. ----
# Two kinds of churn that Bulig cannot cause and that happen on every run are reported, not compared:
#   - the run state of a service a timer starts (a oneshot is "activating" mid-run, "inactive dead" after, "failed" if its own run failed).
#     Its unit file, its enabled state and the timer itself are still compared, in their own sections.
#   - a new container from an image that was already running at the precheck (a per-session agent container).
#     A new image, a removed container or a container that changed state still fails.
SNAPSHOT_RUNSTATE_SECTIONS='^## (running services|every service unit and its state)'
SNAPSHOT_TIMER_SECTION='^## timers and what they start'
SNAPSHOT_DOCKER_SECTION='^## docker containers'

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
# the copies is the verdict, and print one info line per change left out (a warn line when a timer's service is now failed).
snapshot_compare() {
  local before="$1" after="$2" u ctr b a timed="" new_ctrs=""
  # Services whose run-state lines differ, then the ones a timer starts.
  for u in $(comm -3 <(snapshot_section "$before" "$SNAPSHOT_RUNSTATE_SECTIONS" | sort) <(snapshot_section "$after" "$SNAPSHOT_RUNSTATE_SECTIONS" | sort) | awk '{print $1}' | sort -u); do
    if timer_started "$u" "$before" "$after"; then timed="$timed $u"; fi
  done
  for u in $timed; do
    b="$(snapshot_section "$before" '^## every service unit and its state' | awk -v u="$u" '$1 == u { print $2, $3; exit }')"
    a="$(snapshot_section "$after" '^## every service unit and its state' | awk -v u="$u" '$1 == u { print $2, $3; exit }')"
    [ "$b" != "$a" ] || continue
    case " $a " in
      *" failed "*) echo "warn  $u is failed now (${b:-not loaded} at the precheck). A timer starts it, so its run state is not compared, but its own run failed: look at it (systemctl status $u)." ;;
      *) echo "info  $u: ${b:-not loaded} -> ${a:-not loaded} (a timer starts it; its run state is not compared)" ;;
    esac
  done
  # New containers from an image that was already running.
  while read -r ctr; do
    [ -n "$ctr" ] || continue
    new_ctrs="$new_ctrs ${ctr%% *}"
    echo "info  new container ${ctr%% *} from ${ctr#* } (that image was already running at the precheck; not compared)"
  done < <(awk -v h="$SNAPSHOT_DOCKER_SECTION" '
      FNR == 1 { file++ }
      /^## / { on = ($0 ~ h); next }
      !on || NF < 3 { next }
      file == 1 { seen[$1] = 1; if ($3 == "running") running[$2] = 1; next }
      !($1 in seen) && ($2 in running) { print $1, $2 }' "$before" "$after")
  # The copies: the same lines minus those.
  snapshot_drop "$before" "$timed" "$new_ctrs" >"$3"
  snapshot_drop "$after" "$timed" "$new_ctrs" >"$4"
}

# snapshot_drop <file> <services> <containers>: the file without those services' run-state lines and those containers' lines.
snapshot_drop() {
  awk -v units=" $2 " -v ctrs=" $3 " -v rs="$SNAPSHOT_RUNSTATE_SECTIONS" -v dk="$SNAPSHOT_DOCKER_SECTION" '
    /^## / { sec = ($0 ~ rs) ? "rs" : ($0 ~ dk) ? "dk" : ""; print; next }
    sec == "rs" && index(units, " " $1 " ") { next }
    sec == "dk" && index(ctrs, " " $1 " ") { next }
    { print }' "$1"
}
