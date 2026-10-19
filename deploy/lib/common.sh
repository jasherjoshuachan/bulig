# shellcheck shell=bash disable=SC2034
# Shared helpers for the Bulig deploy scripts. Source it; do not run it.
# Everything here is about ONE Postgres cluster (16 bulig, port 5436) and a fixed set of Bulig-owned paths. No script takes a
# free-form path from its command line: a typo must not be able to re-mode /etc or /tmp.

BULIG_PG_VERSION=16
BULIG_PG_CLUSTER=bulig
BULIG_PG_PORT=5436
BULIG_PG_SOCKET_DIR=/var/run/postgresql
# The kernel's worker gateway (PR-C): 127.0.0.1, plus the Tailscale address for the Mac worker.
BULIG_GATEWAY_PORT=7431

# The tests run the scripts against a throwaway folder: BULIG_DEPLOY_TEST_ROOT puts every fixed path under it and skips the
# root check. On the server it is never set.
R="${BULIG_DEPLOY_TEST_ROOT:-}"
BULIG_HOME="/var/lib/bulig"
BULIG_WORKER_HOME="/var/lib/bulig-worker"
# Where the kernel keeps repo clones and its own worktrees (user bulig only), and where the worker keeps its own clones (user bulig-worker
# only). Nothing is shared: the worker sends the kernel a patch, and the kernel applies it in its own worktree (ADR 0011, PR #50).
BULIG_REPOS_DIR="/var/lib/bulig/repos"
BULIG_WORKER_WORK_DIR="/var/lib/bulig-worker/work"
BULIG_CRED_DIR="$R/etc/bulig"
BULIG_BACKUP_ENV_FILE="$R/etc/bulig/backup.env"
BULIG_CHECKS_DIR="$R/var/lib/bulig-checks"
BULIG_BACKUP_DIR="$R/var/backups/bulig"
# Root-owned list of the dumps this host made, with their sha256. The restore drill refuses anything that is not in it.
# It lives under /var/backups (root's), not under /var/lib/bulig, because the bulig user owns /var/lib/bulig and could swap a folder there.
BULIG_BACKUP_INDEX="$R/var/backups/bulig/index"

# One secret per root-only file in /etc/bulig, loaded by systemd LoadCredential= into the units that need it. Each unit gets only its own.
BULIG_CREDENTIALS="pg-url gh-token worker-tokens claude-token worker-token drill-pw"
# R2 settings: the only names the backup file may hold.
BULIG_BACKUP_KEYS="R2_ENDPOINT R2_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION AWS_REQUEST_CHECKSUM_CALCULATION AWS_RESPONSE_CHECKSUM_VALIDATION"

die() {
  echo "$(basename "$0"): $*" >&2
  exit 1
}

is_root() { [ "$(id -u)" -eq 0 ]; }

need_root() {
  [ -n "$R" ] || is_root || die "run as root"
}

# Folders are made by setup-user.sh. Nothing else creates or re-modes a folder it does not own.
need_dir() {
  [ -d "$1" ] && [ ! -L "$1" ] || die "$1 is missing (or is a link). Run setup-user.sh first."
}

# The folder for the before/after snapshots. Made once (mode 0700); an existing one is checked, never re-moded.
ensure_checks_dir() {
  [ ! -L "$BULIG_CHECKS_DIR" ] || die "$BULIG_CHECKS_DIR is a link. Not touching it."
  if [ ! -d "$BULIG_CHECKS_DIR" ]; then
    (umask 077 && mkdir "$BULIG_CHECKS_DIR") || die "cannot create $BULIG_CHECKS_DIR"
  fi
  if is_root && [ "$(stat -c %u "$BULIG_CHECKS_DIR")" != "0" ]; then die "$BULIG_CHECKS_DIR is not owned by root. Not touching it."; fi
}

# Prefer the Postgres 16 client tools by path, so a newer client on PATH never talks to this cluster by accident.
pg_bin() {
  local tool="$1" p="/usr/lib/postgresql/$BULIG_PG_VERSION/bin/$1"
  if [ -x "$p" ]; then echo "$p"; else command -v "$tool" || die "$tool not found"; fi
}

# Run a command as the postgres OS user (peer auth over the local socket). Used only to create roles and databases at setup.
as_postgres() {
  setpriv --reuid=postgres --regid=postgres --init-groups "$@"
}

# psql as the postgres superuser on the Bulig cluster only. Port and socket are fixed here on purpose. Setup scripts only: the
# backup, the drill and health never connect as a superuser.
psql_admin() {
  as_postgres "$(pg_bin psql)" -X -q -h "$BULIG_PG_SOCKET_DIR" -p "$BULIG_PG_PORT" -U postgres -v ON_ERROR_STOP=1 "$@"
}

# cred_write <name>: write stdin to /etc/bulig/<name> as one secret, root-only (0600), atomically. Only the known names are accepted,
# and only inside /etc/bulig. Prints the length, never the value.
cred_write() {
  local name="$1" tmp value known=0 n
  for n in $BULIG_CREDENTIALS; do [ "$n" = "$name" ] && known=1; done
  [ "$known" -eq 1 ] || die "unknown credential '$name' (known: $BULIG_CREDENTIALS)"
  need_dir "$BULIG_CRED_DIR"
  value="$(cat)"
  value="${value%$'\n'}"
  tmp="$(mktemp "$BULIG_CRED_DIR/.${name}.XXXXXX")"
  chmod 600 "$tmp"
  printf '%s' "$value" >"$tmp"
  if is_root; then chown root:root "$tmp"; fi
  mv "$tmp" "$BULIG_CRED_DIR/$name"
  echo "wrote $BULIG_CRED_DIR/$name (${#value} characters, root, 0600)"
}

# backup_key_write <NAME>: set one R2 setting in /etc/bulig/backup.env from stdin, keeping every other line. Known names only.
backup_key_write() {
  local name="$1" tmp value known=0 n file="$BULIG_BACKUP_ENV_FILE"
  for n in $BULIG_BACKUP_KEYS; do [ "$n" = "$name" ] && known=1; done
  [ "$known" -eq 1 ] || die "unknown backup setting '$name' (known: $BULIG_BACKUP_KEYS)"
  need_dir "$BULIG_CRED_DIR"
  value="$(cat)"
  value="${value%$'\n'}"
  [ -n "$value" ] || die "nothing on stdin"
  case "$value" in *$'\n'*) die "the value has more than one line" ;; esac
  tmp="$(mktemp "$BULIG_CRED_DIR/.backup-env.XXXXXX")"
  chmod 600 "$tmp"
  if [ -f "$file" ]; then grep -v "^${name}=" "$file" >"$tmp" || true; fi
  printf '%s=%s\n' "$name" "$value" >>"$tmp"
  if is_root; then chown root:root "$tmp"; fi
  mv "$tmp" "$file"
  echo "set $name in $file (${#value} characters)"
}

# In a unit that has LoadCredential=, the secret is in $CREDENTIALS_DIRECTORY. By hand, as root, it is in /etc/bulig.
cred_path() {
  local name="$1"
  if [ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -r "$CREDENTIALS_DIRECTORY/$name" ]; then echo "$CREDENTIALS_DIRECTORY/$name"; else echo "$BULIG_CRED_DIR/$name"; fi
}

# One field of a PGPASSFILE line: backslash and colon are escaped.
pgpass_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/:/\\:/g'
}

# pg_passfile <url-credential-file> <user-credential-name-or-empty> <dir>: build a PGPASSFILE (0600) in a private folder from a
# postgres://user:password@host:port/db URL, so the password never appears in a command line (ps shows every process's arguments).
# Prints the passfile path. Fields: host:port:database:user:password, with \ and : escaped.
pg_passfile() {
  local url_file="$1" dir="$2" url rest user pw hostport host port db out
  url="$(cat "$url_file")" || die "cannot read $url_file"
  case "$url" in postgres://*) ;; *) die "$url_file does not hold a postgres:// URL" ;; esac
  rest="${url#postgres://}"
  user="${rest%%:*}"
  rest="${rest#*:}"
  pw="${rest%%@*}"
  rest="${rest#*@}"
  hostport="${rest%%/*}"
  db="${rest#*/}"
  host="${hostport%%:*}"
  port="${hostport##*:}"
  [ -n "$user" ] && [ -n "$pw" ] && [ -n "$host" ] && [ -n "$port" ] && [ -n "$db" ] || die "$url_file is not postgres://user:password@host:port/db"
  out="$dir/pgpass"
  (umask 077 && printf '%s:%s:%s:%s:%s\n' "$(pgpass_escape "$host")" "$(pgpass_escape "$port")" "$(pgpass_escape "$db")" "$(pgpass_escape "$user")" "$(pgpass_escape "$pw")" >"$out")
  echo "$out"
}
