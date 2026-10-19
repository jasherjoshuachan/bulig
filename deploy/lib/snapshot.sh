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

  echo "## /etc/systemd/system: file hashes and link targets (names containing bulig left out)"
  if [ -d "$R/etc/systemd/system" ]; then
    find "$R/etc/systemd/system" -type f -not -name '*bulig*' -print0 | sort -z | xargs -0 -r sha256sum
    # shellcheck disable=SC2016
    find "$R/etc/systemd/system" -type l -not -name '*bulig*' -print0 | sort -z | xargs -0 -r -n1 sh -c 'echo "$0 -> $(readlink "$0")"'
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
