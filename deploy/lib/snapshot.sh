# shellcheck shell=bash
# What "client production untouched" means, as text. Source it after common.sh; do not run it.
# Everything Bulig owns is filtered out of both snapshots, so a diff shows only changes to things that are not Bulig's.

# Services that start and stop on their own schedule. They would make a diff fail for reasons that have nothing to do with Bulig.
SNAPSHOT_NOISE='^(apt-daily|apt-daily-upgrade|fwupd-refresh|motd-news|man-db|e2scrub|logrotate|sysstat|systemd-tmpfiles-clean|update-notifier|ua-timer|dpkg-db-backup|phpsessionclean|certbot|user@|user-runtime-dir@|sshd@|session-)'

# Not Bulig's, not noise, so any change is a change to something else on the host.
snapshot() {
  echo "## pg_lsclusters (the bulig cluster is left out)"
  if command -v pg_lsclusters >/dev/null 2>&1; then
    pg_lsclusters -h | awk -v c="$BULIG_PG_CLUSTER" -v p="$BULIG_PG_PORT" '!($2 == c && $3 == p) {print $1, $2, $3, $4, $5, $6}' | sort
  else
    echo "(no pg_lsclusters)"
  fi

  echo "## running services (bulig and postgresql@16-bulig left out)"
  systemctl list-units --type=service --state=running --no-legend --plain --no-pager \
    | awk '{print $1}' | grep -Ev '^(bulig|postgresql@16-bulig)' | grep -Ev "$SNAPSHOT_NOISE" | sort

  echo "## listening tcp sockets (port $BULIG_PG_PORT left out; pids stripped)"
  ss -H -ltnp 2>/dev/null \
    | awk -v p=":$BULIG_PG_PORT" '{ addr = $4; proc = ($NF ~ /^users:/) ? $NF : "-"; if (addr !~ p "$") print addr, proc }' \
    | sed -E 's/pid=[0-9]+,?//g; s/,?fd=[0-9]+//g' | sort -u

  echo "## NanoClaw and Temporal services (all states)"
  systemctl list-units --type=service --all --no-legend --plain --no-pager \
    | awk '{print $1, $3, $4}' | grep -Ei 'nanoclaw|temporal' | sort || true

  echo "## docker containers (name, image, state)"
  if command -v docker >/dev/null 2>&1; then
    docker ps -a --format '{{.Names}} {{.Image}} {{.State}}' 2>/dev/null | sort || true
  else
    echo "(no docker)"
  fi

  echo "## service unit files (bulig left out)"
  systemctl list-unit-files --type=service --no-legend --plain --no-pager | awk '{print $1, $2}' | grep -Ev '^(bulig|postgresql@16-bulig)' | sort

  echo "## postgresql config of the other clusters (sha256)"
  if [ -d /etc/postgresql ]; then
    find /etc/postgresql -type f -not -path "*/$BULIG_PG_VERSION/$BULIG_PG_CLUSTER/*" -print0 | sort -z | xargs -0 -r sha256sum
  fi
}
