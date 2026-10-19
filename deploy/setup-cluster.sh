#!/usr/bin/env bash
# Create the Postgres 16 cluster "bulig" on port 5436, its own role and database, and write the connection URL into the root-only file /etc/bulig/pg-url.
# Idempotent. Never touches cluster 16/main or any other port. Run as root on ths-prod-01 after setup-user.sh.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
need_root

command -v pg_createcluster >/dev/null 2>&1 || die "pg_createcluster not found (postgresql-common is not installed)"
[ -d "/usr/lib/postgresql/$BULIG_PG_VERSION/bin" ] || die "postgresql-$BULIG_PG_VERSION is not installed"
need_dir "$BULIG_CRED_DIR"

# 1. Is port 5436 free, or already ours? Check what listens, and what any cluster (running or not) is configured for.
ours_exists=0
if pg_lsclusters -h | awk -v v="$BULIG_PG_VERSION" -v c="$BULIG_PG_CLUSTER" '$1 == v && $2 == c {found = 1} END {exit !found}'; then
  ours_exists=1
  port_now="$(pg_lsclusters -h | awk -v v="$BULIG_PG_VERSION" -v c="$BULIG_PG_CLUSTER" '$1 == v && $2 == c {print $3}')"
  [ "$port_now" = "$BULIG_PG_PORT" ] || die "cluster $BULIG_PG_VERSION $BULIG_PG_CLUSTER exists on port $port_now, not $BULIG_PG_PORT. Not touching it."
fi
other="$(pg_lsclusters -h | awk -v v="$BULIG_PG_VERSION" -v c="$BULIG_PG_CLUSTER" -v p="$BULIG_PG_PORT" '$3 == p && !($1 == v && $2 == c) {print $1 "/" $2}')"
[ -z "$other" ] || die "port $BULIG_PG_PORT is configured for cluster $other. Not touching it."
listening="$(ss -H -ltnp "sport = :$BULIG_PG_PORT" 2>/dev/null || true)"
if [ -n "$listening" ] && [ "$ours_exists" -eq 0 ]; then
  die "something is already listening on port $BULIG_PG_PORT and it is not the $BULIG_PG_VERSION $BULIG_PG_CLUSTER cluster. Pick another port."
fi
# Even when the cluster is ours, what listens must be Postgres. A different program on 5436 means a mix-up; stop and look.
if [ -n "$listening" ] && ! printf '%s\n' "$listening" | grep -Eq 'users:\(\("(postgres|postmaster)"'; then
  die "port $BULIG_PG_PORT has a listener that is not postgres: $listening"
fi

# 2. The cluster. scram-sha-256 for TCP, peer for the local socket (so root and postgres need no password locally).
if [ "$ours_exists" -eq 0 ]; then
  pg_createcluster "$BULIG_PG_VERSION" "$BULIG_PG_CLUSTER" --port "$BULIG_PG_PORT" -- --auth-local=peer --auth-host=scram-sha-256
  echo "cluster: created"
else
  echo "cluster: already there"
fi

# 3. Listen on localhost only. conf.d is included by the Debian postgresql.conf. Written only for this cluster.
conf_d="/etc/postgresql/$BULIG_PG_VERSION/$BULIG_PG_CLUSTER/conf.d"
install -d -m 0755 "$conf_d"
want_conf="listen_addresses = 'localhost'
port = $BULIG_PG_PORT
password_encryption = 'scram-sha-256'
"
if [ "$(cat "$conf_d/bulig.conf" 2>/dev/null || true)" != "${want_conf%$'\n'}" ]; then
  printf '%s' "$want_conf" >"$conf_d/bulig.conf"
  chown postgres:postgres "$conf_d/bulig.conf"
  restart_needed=1
else
  restart_needed=0
fi

# 4. Start (or restart if the config just changed). Only this cluster.
status="$(pg_lsclusters -h | awk -v v="$BULIG_PG_VERSION" -v c="$BULIG_PG_CLUSTER" '$1 == v && $2 == c {print $4}')"
if [ "$status" != "online" ]; then
  pg_ctlcluster "$BULIG_PG_VERSION" "$BULIG_PG_CLUSTER" start
elif [ "$restart_needed" -eq 1 ]; then
  pg_ctlcluster "$BULIG_PG_VERSION" "$BULIG_PG_CLUSTER" restart
fi
for _ in $(seq 1 30); do
  "$(pg_bin pg_isready)" -q -h "$BULIG_PG_SOCKET_DIR" -p "$BULIG_PG_PORT" && break
  sleep 1
done
"$(pg_bin pg_isready)" -q -h "$BULIG_PG_SOCKET_DIR" -p "$BULIG_PG_PORT" || die "cluster did not come up on port $BULIG_PG_PORT"

# 5. Role and database. The password is generated once. On a re-run the one already in /etc/bulig/pg-url is reused.
url="$(cat "$BULIG_CRED_DIR/pg-url" 2>/dev/null || true)"
if [ -n "$url" ]; then
  pw="${url#postgres://bulig:}"
  pw="${pw%%@*}"
  [ -n "$pw" ] && [ "$pw" != "$url" ] || die "$BULIG_CRED_DIR/pg-url is not in the form postgres://bulig:<password>@127.0.0.1:$BULIG_PG_PORT/bulig. Fix or remove that file and run again."
else
  pw="$(openssl rand -hex 24)"
fi

if [ "$(psql_admin -tA -c "SELECT 1 FROM pg_roles WHERE rolname = 'bulig'")" != "1" ]; then
  psql_admin -c "CREATE ROLE bulig LOGIN"
  echo "role: created"
else
  echo "role: already there"
fi
# The password goes in through stdin, never through a command line (ps would show it).
printf "ALTER ROLE bulig PASSWORD '%s';\n" "$pw" | psql_admin -f - >/dev/null
if [ "$(psql_admin -tA -c "SELECT 1 FROM pg_database WHERE datname = 'bulig'")" != "1" ]; then
  psql_admin -c "CREATE DATABASE bulig OWNER bulig"
  echo "database: created"
else
  echo "database: already there"
fi
psql_admin -c "REVOKE CONNECT ON DATABASE bulig FROM PUBLIC"

# The restore drill's own login. It can create databases (its scratch ones) and nothing else: not a superuser, no role creation, and it
# cannot connect to the bulig database. Its password is a credential for the drill unit only. Reused on a re-run.
drill_pw="$(cat "$BULIG_CRED_DIR/drill-pw" 2>/dev/null || true)"
[ -n "$drill_pw" ] || drill_pw="$(openssl rand -hex 24)"
if [ "$(psql_admin -tA -c "SELECT 1 FROM pg_roles WHERE rolname = 'bulig_drill'")" != "1" ]; then
  psql_admin -c "CREATE ROLE bulig_drill LOGIN NOSUPERUSER NOCREATEROLE CREATEDB NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5"
  echo "role bulig_drill: created"
else
  echo "role bulig_drill: already there"
fi
printf "ALTER ROLE bulig_drill PASSWORD '%s';\n" "$drill_pw" | psql_admin -f - >/dev/null
printf '%s' "$drill_pw" | cred_write drill-pw >/dev/null
echo "credential: $BULIG_CRED_DIR/drill-pw written (mode 600, root)"

# 6. The URL, with an explicit host (a URL without one would fall back to the default socket and port, which may be another cluster).
# It goes into a root-only credential file, loaded by systemd LoadCredential= into the kernel unit and the backup units only.
printf 'postgres://bulig:%s@127.0.0.1:%s/bulig' "$pw" "$BULIG_PG_PORT" | cred_write pg-url >/dev/null
echo "credential: $BULIG_CRED_DIR/pg-url written (mode 600, root)"

# 7. Prove the password works over TCP, the way the service will connect.
if PGPASSWORD="$pw" "$(pg_bin psql)" -X -q -h 127.0.0.1 -p "$BULIG_PG_PORT" -U bulig -d bulig -tA -c "SELECT 1" >/dev/null; then
  echo "login: bulig@127.0.0.1:$BULIG_PG_PORT ok"
else
  die "bulig could not log in over TCP on 127.0.0.1:$BULIG_PG_PORT"
fi
echo "setup-cluster: done"
