# shellcheck shell=bash disable=SC2034
# Shared helpers for the Bulig deploy scripts. Source it; do not run it.
# Everything here is about ONE Postgres cluster (16 bulig, port 5436). Nothing in the deploy kit may touch another cluster or port.

BULIG_PG_VERSION=16
BULIG_PG_CLUSTER=bulig
BULIG_PG_PORT=5436
BULIG_PG_SOCKET_DIR=/var/run/postgresql
# One secret per root-only file, loaded by systemd LoadCredential= and read by the kernel from $CREDENTIALS_DIRECTORY.
# Never in the unit's environment: Claude sessions the worker starts inherit it, and they must not hold the database URL or tokens.
BULIG_CRED_DIR=/etc/bulig
BULIG_CREDENTIALS="pg-url gh-token claude-token worker-tokens"
# Only the R2 backup keys still use a KEY=value file. It belongs to the backup units, never to the kernel.
BULIG_ENV_FILE=/etc/bulig/backup.env
BULIG_BACKUP_ENV_FILE=/etc/bulig/backup.env
BULIG_HOME=/var/lib/bulig

die() {
  echo "$(basename "$0"): $*" >&2
  exit 1
}

need_root() {
  [ "$(id -u)" -eq 0 ] || die "run as root"
}

# Prefer the Postgres 16 client tools by path, so a newer client on PATH never talks to this cluster by accident.
pg_bin() {
  local tool="$1" p="/usr/lib/postgresql/$BULIG_PG_VERSION/bin/$1"
  if [ -x "$p" ]; then echo "$p"; else command -v "$tool" || die "$tool not found"; fi
}

# Run a command as the postgres OS user (peer auth over the local socket). setpriv has no PAM session, so it works under a locked-down unit.
as_postgres() {
  setpriv --reuid=postgres --regid=postgres --init-groups "$@"
}

# psql as the postgres superuser on the Bulig cluster only. Port and socket are fixed here on purpose.
psql_admin() {
  as_postgres "$(pg_bin psql)" -X -q -h "$BULIG_PG_SOCKET_DIR" -p "$BULIG_PG_PORT" -U postgres -v ON_ERROR_STOP=1 "$@"
}

# cred_write <name>: write stdin to /etc/bulig/<name> as one secret, root-only (0600), atomically. Prints the length, never the value.
cred_write() {
  local name="$1" tmp value
  case "$name" in pg-url | gh-token | claude-token | worker-tokens) ;; *) die "unknown credential '$name' (known: $BULIG_CREDENTIALS)" ;; esac
  value="$(cat)"
  value="${value%$'\n'}"
  install -d -m 0700 "$BULIG_CRED_DIR"
  tmp="$(mktemp "$BULIG_CRED_DIR/.${name}.XXXXXX")"
  chmod 600 "$tmp"
  printf '%s' "$value" >"$tmp"
  chown root:root "$tmp"
  mv "$tmp" "$BULIG_CRED_DIR/$name"
  echo "wrote $BULIG_CRED_DIR/$name (${#value} characters, root, 0600)"
}

# In a unit that has LoadCredential=, the secret is in $CREDENTIALS_DIRECTORY. By hand, as root, it is in /etc/bulig.
cred_path() {
  local name="$1"
  if [ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -r "$CREDENTIALS_DIRECTORY/$name" ]; then echo "$CREDENTIALS_DIRECTORY/$name"; else echo "$BULIG_CRED_DIR/$name"; fi
}

# One value out of an env file, without sourcing it (a token with a $ or a space must not be executed).
env_value() {
  local name="$1" file="${2:-$BULIG_ENV_FILE}"
  [ -r "$file" ] || return 1
  grep -m1 "^${name}=" "$file" | cut -d= -f2-
}

# Set NAME=value in an env file, keeping every other line, written atomically at mode 0600. Shell functions and printf are builtins,
# so a value passed here never shows in ps. Callers feed it from a shell variable or stdin, never from a command-line argument.
env_set() {
  local name="$1" value="$2" file="${3:-$BULIG_ENV_FILE}" tmp
  install -d -m 0700 "$(dirname "$file")"
  tmp="$(mktemp "${file}.XXXXXX")"
  chmod 600 "$tmp"
  if [ -f "$file" ]; then grep -v "^${name}=" "$file" >"$tmp" || true; fi
  printf '%s=%s\n' "$name" "$value" >>"$tmp"
  mv "$tmp" "$file"
}
