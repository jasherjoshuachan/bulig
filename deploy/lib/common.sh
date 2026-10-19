# shellcheck shell=bash disable=SC2034
# Shared helpers for the Bulig deploy scripts. Source it; do not run it.
#
# THE INVARIANT (also at the top of RUNBOOK.md, and enforced by deploy/test/invariant.sh):
#   Root never creates, writes, chmods, chowns or deletes any path whose parent directory (at any level) is owned by or writable by
#   bulig or bulig-worker. Everything root manages lives under root-owned parents: /etc/bulig, /usr/local/lib/bulig, /var/backups/bulig,
#   /var/lib/bulig-checks, /opt/bulig. Per-user state (/var/lib/bulig, /var/lib/bulig-worker) is created only by systemd (StateDirectory=),
#   and the programs create everything inside it themselves, as their own user.
# So this file defines no variable for either user's folder. A script that wants one has to write the path out, and the invariant checker
# fails the build when it sees one.

BULIG_PG_VERSION=16
BULIG_PG_CLUSTER=bulig
BULIG_PG_PORT=5436
BULIG_PG_SOCKET_DIR=/var/run/postgresql
# Every client reaches this cluster over the unix socket in that folder, by its full path and port. The cluster has no TCP listener at all, so
# no unit needs to reach 127.0.0.1 (other tenants' services listen there).
BULIG_PG_HOST=/var/run/postgresql
# The kernel's worker gateway (ADR 0011): its own loopback address, plus the Tailscale address for the Mac worker.
BULIG_GATEWAY_ADDR=127.74.3.1
BULIG_GATEWAY_PORT=7431
# What the units that run code Bulig does not control (the worker, the release build, one-off worker commands) may reach. The unit files carry
# the same values as text and deploy/test/units.sh checks them; the transient units (release build, bulig-cli.sh) take them from here, and
# fence-check.sh tests the result against the real machine.
#  - IPAddressDeny: everything local or private (the public internet is what is left), plus the host's own public addresses (host_addresses).
#  - RestrictAddressFamilies without AF_UNIX: no unix socket at all, abstract ones included. socketpair() is not affected by it.
#  - InaccessiblePaths: the other unix sockets that could be reached if AF_UNIX were ever allowed ("-" = ignore a missing path).
#  - BindReadOnlyPaths: resolved's upstream resolver list instead of the 127.0.0.53 stub, so no localhost address has to be allowed for DNS.
BULIG_IP_DENY_PRIVATE="localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7"
BULIG_AF_NO_UNIX="AF_INET AF_INET6"
BULIG_AF_WITH_UNIX="AF_UNIX AF_INET AF_INET6"
BULIG_INACCESSIBLE="-/run/tailscale -/run/snapd.socket -/run/docker.sock -/var/run/docker.sock"
BULIG_RESOLV_BIND="/run/systemd/resolve/resolv.conf:/etc/resolv.conf"

# The tests run the scripts against a throwaway folder: BULIG_DEPLOY_TEST_ROOT puts every fixed path under it and skips the
# root check. On the server it is never set.
R="${BULIG_DEPLOY_TEST_ROOT:-}"
BULIG_CRED_DIR="$R/etc/bulig"
BULIG_BACKUP_ENV_FILE="$R/etc/bulig/backup.env"
BULIG_OPT_DIR="$R/opt/bulig"
BULIG_TOOLS_DIR="$R/usr/local/lib/bulig"
BULIG_UNIT_DIR="$R/etc/systemd/system"
BULIG_CHECKS_DIR="$R/var/lib/bulig-checks"
BULIG_BACKUP_DIR="$R/var/backups/bulig"
# Root-owned list of the dumps this host made, with their sha256. The restore drill refuses anything that is not in it.
BULIG_BACKUP_INDEX="$R/var/backups/bulig/index"
# The two users, and the paths NOT to touch (named here only so need_dir can refuse them; nothing is ever written to them).
BULIG_USERS="bulig bulig-worker"
BULIG_USER_STATE_PREFIXES="$R/var/lib/bulig $R/var/lib/bulig-worker"

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

# refuse_if_users_running: a setup script must not run while any process of either Bulig user exists. A running process can swap a link
# or rename a folder at the moment a root script looks at it. Stop both services first (and any bulig-cli.sh command).
refuse_if_users_running() {
  local u
  for u in $BULIG_USERS; do
    id "$u" >/dev/null 2>&1 || continue
    if pgrep -u "$u" >/dev/null 2>&1; then
      die "processes of user $u are running. Stop them first: systemctl stop bulig-worker bulig (a setup script never runs next to the users it sets up)."
    fi
  done
}

# under_user_state <path>: true when the path is, or lies inside, either user's state folder (resolved through links where it can be).
under_user_state() {
  local p="$1" resolved prefix real_parent real_prefix
  resolved="$p"
  if [ -d "$p" ]; then resolved="$(cd -P "$p" && pwd)"; fi
  for prefix in $BULIG_USER_STATE_PREFIXES; do
    # The prefix may not exist (systemd makes it later), and a folder above it may be a link, so resolve its parent.
    real_prefix="$prefix"
    real_parent="$(cd -P "$(dirname "$prefix")" 2>/dev/null && pwd)" && real_prefix="$real_parent/$(basename "$prefix")"
    case "$resolved/" in "$prefix"/* | "$real_prefix"/*) return 0 ;; esac
    case "$p/" in "$prefix"/* | "$real_prefix"/*) return 0 ;; esac
  done
  return 1
}

# need_dir <path>: a folder root may work in. It must exist, must not be a link, must not be inside either user's folder, and (on the
# server) it and every folder above it must be owned by root and not writable by group or others. Nothing creates or re-modes a folder
# it does not own.
need_dir() {
  local d="$1" up mode owner
  [ -d "$d" ] && [ ! -L "$d" ] || die "$d is missing (or is a link). Run setup-user.sh first."
  under_user_state "$d" && die "$d is inside a Bulig user's folder. Root never works there."
  if [ -z "$R" ] && is_root; then
    up="$(cd -P "$d" && pwd)"
    while :; do
      read -r owner mode < <(stat -c '%u %a' "$up")
      [ "$owner" = "0" ] || die "$up is not owned by root, so root must not work under it."
      # group and other write bits (the 2 in the last two digits)
      case "${mode: -2:1}" in 2 | 3 | 6 | 7) die "$up is writable by its group, so root must not work under it." ;; esac
      case "${mode: -1}" in 2 | 3 | 6 | 7) die "$up is writable by anyone, so root must not work under it." ;; esac
      [ "$up" = "/" ] && break
      up="$(dirname "$up")"
    done
  fi
}

# root_dir <mode> <path>: create (or check) a root-owned folder whose parent already exists and is root's. A link is refused. chown -h so
# a link swapped in at the last moment is never followed.
root_dir() {
  local mode="$1" path="$2" parent
  parent="$(dirname "$path")"
  [ -d "$parent" ] || die "$parent does not exist"
  need_dir "$parent"
  [ ! -L "$path" ] || die "$path is a link. Not touching it."
  under_user_state "$path" && die "$path is inside a Bulig user's folder. Root never works there."
  install -d -m "$mode" "$path"
  if is_root; then chown -h root:root "$path"; fi
  echo "dir $mode root:root $path"
}

# The folder for the before/after snapshots and the release work areas. Made once (mode 0700), root's.
ensure_checks_dir() {
  root_dir 0700 "$BULIG_CHECKS_DIR" >/dev/null
}

# private_tmpdir: a fresh 0700 folder inside /var/lib/bulig-checks (root's), for passfiles and downloads. Never the host's /tmp.
private_tmpdir() {
  ensure_checks_dir
  mktemp -d -p "$BULIG_CHECKS_DIR" "work.XXXXXX"
}

# epoch_from_utc <Y> <M> <D> <h> <m> <s>: seconds since 1970 for a UTC time, in plain bash arithmetic (no GNU date -d, so it also runs in the tests).
epoch_from_utc() {
  local y=$((10#$1)) m=$((10#$2)) d=$((10#$3)) h=$((10#$4)) mi=$((10#$5)) s=$((10#$6)) era yoe doy doe days
  [ "$m" -le 2 ] && y=$((y - 1))
  era=$((y / 400))
  yoe=$((y - era * 400))
  doy=$(((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1))
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  days=$((era * 146097 + doe - 719468))
  echo $((days * 86400 + h * 3600 + mi * 60 + s))
}

# Prefer the Postgres 16 client tools by path, so a newer client on PATH never talks to this cluster by accident.
pg_bin() {
  local tool="$1" p="/usr/lib/postgresql/$BULIG_PG_VERSION/bin/$1"
  # (In the tests, R is set and the tool is whatever stub is first on PATH.)
  if [ -z "$R" ] && [ -x "$p" ]; then echo "$p"; else command -v "$tool" || die "$tool not found"; fi
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

# host_addresses: this machine's own public addresses, one per line as /32 or /128, read from `ip -o addr` (private, tailscale and unique-local
# ranges are left out: they are denied already). Written into a drop-in at setup time, never hard-coded.
host_addresses() {
  { ip -o addr show scope global 2>/dev/null || true; } | awk '
    { a = $4; sub("/.*", "", a) }
    a ~ /:/ { if (a ~ /^f[cd]/) next; print a "/128"; next }
    a ~ /^(10\.|192\.168\.)/ { next }
    a ~ /^172\.(1[6-9]|2[0-9]|3[01])\./ { next }
    a ~ /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./ { next }
    { print a "/32" }' | sort -u
}

# write_host_dropin <unit>: /etc/systemd/system/<unit>.d/10-host-addresses.conf, root-owned, with IPAddressDeny= for those addresses.
write_host_dropin() {
  local unit="$1" dir="$BULIG_UNIT_DIR/$1.d" addrs
  addrs="$(host_addresses | tr '\n' ' ')"
  addrs="${addrs% }"
  root_dir 0755 "$dir" >/dev/null
  {
    echo "# Written by deploy/host-addresses.sh (root). This machine's own public addresses, so $unit cannot connect to its own public listeners."
    echo "[Service]"
    if [ -n "$addrs" ]; then echo "IPAddressDeny=$addrs"; fi
  } | install_root_file "$dir/10-host-addresses.conf"
}

# build_fence_props: sets FENCE_BUILD, the properties of the transient release-build unit that decide what it can reach. A throwaway user.
FENCE_BUILD=()
build_fence_props() {
  local deny="$BULIG_IP_DENY_PRIVATE" a
  a="$(host_addresses | tr '\n' ' ')"
  deny="$deny ${a% }"
  FENCE_BUILD=(-p DynamicUser=yes -p "RestrictAddressFamilies=$BULIG_AF_NO_UNIX" -p "IPAddressDeny=${deny% }" \
    -p "InaccessiblePaths=$BULIG_INACCESSIBLE" -p "BindReadOnlyPaths=$BULIG_RESOLV_BIND")
}

# cli_fence_props <kernel|worker>: sets FENCE_CLI for a one-off bulig-cli.sh command. The kernel keeps AF_UNIX (the Postgres socket), the worker does not.
FENCE_CLI=()
cli_fence_props() {
  local role="$1" deny="$BULIG_IP_DENY_PRIVATE" a
  case "$role" in
    kernel)
      FENCE_CLI=(-p "RestrictAddressFamilies=$BULIG_AF_WITH_UNIX" -p "IPAddressDeny=$deny" -p "IPAddressAllow=$BULIG_GATEWAY_ADDR/32"
        -p "InaccessiblePaths=$BULIG_INACCESSIBLE" -p "BindReadOnlyPaths=$BULIG_RESOLV_BIND") ;;
    worker)
      a="$(host_addresses | tr '\n' ' ')"
      deny="$deny ${a% }"
      FENCE_CLI=(-p "RestrictAddressFamilies=$BULIG_AF_NO_UNIX" -p "IPAddressDeny=${deny% }" -p "IPAddressAllow=$BULIG_GATEWAY_ADDR/32"
        -p "InaccessiblePaths=$BULIG_INACCESSIBLE" -p "BindReadOnlyPaths=$BULIG_RESOLV_BIND") ;;
    *) die "role must be kernel or worker" ;;
  esac
}

# wildcard_listeners: TCP listeners on every address (0.0.0.0, ::, *), as addr:port, one per line. An allowed address such as 127.74.3.1 reaches
# every one of them, because the IP filter matches addresses and not ports.
wildcard_listeners() {
  ss -H -ltn 2>/dev/null | awk '$4 ~ /^(0\.0\.0\.0|\*|\[::\]|::):[0-9]+$/ { print $4 }' | sort -u
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
  if is_root; then chown -h root:root "$tmp"; fi
  mv "$tmp" "$BULIG_CRED_DIR/$name"
  echo "wrote $BULIG_CRED_DIR/$name (${#value} characters, root, 0600)"
}

# worker_token_write <id>: the token on stdin becomes worker <id>'s line in worker-tokens (the kernel's table, "id=token" per line), and,
# for the VPS worker "vps", also its own worker-token credential. Other lines are kept. Known id characters only.
worker_token_write() {
  local id="$1" tmp value file="$BULIG_CRED_DIR/worker-tokens"
  [[ "$id" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || die "a worker id is lowercase letters, digits and dashes"
  need_dir "$BULIG_CRED_DIR"
  value="$(cat)"
  value="${value%$'\n'}"
  [[ "$value" =~ ^[A-Za-z0-9._~+-]{32,128}$ ]] || die "a worker token is 32 to 128 characters of letters, digits and . _ ~ + -"
  tmp="$(mktemp "$BULIG_CRED_DIR/.worker-tokens.XXXXXX")"
  chmod 600 "$tmp"
  if [ -f "$file" ]; then grep -v "^${id}=" "$file" >"$tmp" || true; fi
  printf '%s=%s\n' "$id" "$value" >>"$tmp"
  if is_root; then chown -h root:root "$tmp"; fi
  mv "$tmp" "$file"
  echo "set worker $id in $file (${#value} characters)"
  if [ "$id" = "vps" ]; then printf '%s' "$value" | cred_write worker-token; fi
}

# worker_env_write: the line on stdin, BULIG_WORKER_REPOS=--repo <kernel path>=<clone> [--repo ...], becomes /etc/bulig/worker.env, which
# bulig-worker.service reads (non-secret, root's). The worker needs at least one --repo. Kernel paths are under /var/lib/bulig/repos and
# clones under /var/lib/bulig-worker/work, the places the kernel and the worker make for themselves. Only a line of that shape is accepted.
worker_env_write() {
  local line tmp file="$BULIG_CRED_DIR/worker.env" part
  need_dir "$BULIG_CRED_DIR"
  line="$(cat)"
  line="${line%$'\n'}"
  case "$line" in *$'\n'*) die "the value has more than one line" ;; esac
  [[ "$line" =~ ^BULIG_WORKER_REPOS=--repo\ /var/lib/bulig/repos/[A-Za-z0-9._/-]+=/var/lib/bulig-worker/work/[A-Za-z0-9._/-]+(\ --repo\ /var/lib/bulig/repos/[A-Za-z0-9._/-]+=/var/lib/bulig-worker/work/[A-Za-z0-9._/-]+)*$ ]] \
    || die "worker.env holds one line: BULIG_WORKER_REPOS=--repo /var/lib/bulig/repos/<name>=/var/lib/bulig-worker/work/<name> [--repo ...]"
  for part in $line; do
    case "$part" in *..*) die "no .. in a repository path" ;; esac
  done
  tmp="$(mktemp "$BULIG_CRED_DIR/.worker-env.XXXXXX")"
  chmod 600 "$tmp"
  printf '%s\n' "$line" >"$tmp"
  if is_root; then chown -h root:root "$tmp"; fi
  mv "$tmp" "$file"
  echo "wrote $file"
}

# install_root_file <dest>: stdin becomes <dest>, root-owned, 0644, in a folder root does not own (Postgres's config folders belong to
# postgres). Written to a root-owned temp file in /var/lib/bulig-checks first, copied beside the target with install -o root, then renamed
# over it with mv -T. A link at the target is refused (and checked again just before the rename).
install_root_file() {
  local dest="$1" dir tmp new
  dir="$(dirname "$dest")"
  [ -d "$dir" ] && [ ! -L "$dir" ] || die "$dir is missing (or is a link)"
  under_user_state "$dir" && die "$dir is inside a Bulig user's folder. Root never works there."
  [ ! -L "$dest" ] || die "$dest is a link. Not touching it."
  ensure_checks_dir
  tmp="$(mktemp -p "$BULIG_CHECKS_DIR" "conf.XXXXXX")"
  cat >"$tmp"
  chmod 0644 "$tmp"
  new="$dest.new.$$"
  if is_root; then install -o root -g root -m 0644 "$tmp" "$new"; else install -m 0644 "$tmp" "$new"; fi
  rm -f "$tmp"
  if [ -L "$dest" ]; then
    rm -f "$new"
    die "$dest became a link. Not touching it."
  fi
  mv -T "$new" "$dest"
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
  if is_root; then chown -h root:root "$tmp"; fi
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

# pg_passfile <url-credential-file> <dir>: build a PGPASSFILE (0600) in a private folder from a postgres://user:password@host:port/db
# URL, so the password never appears in a command line (ps shows every process's arguments). Prints the passfile path.
# Fields: host:port:database:user:password, with \ and : escaped.
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
  host="${hostport%:*}"
  port="${hostport##*:}"
  # A socket folder is written %2Fvar%2Frun%2Fpostgresql (or /var/run/postgresql) in the URL. libpq looks a socket connection up in the
  # passfile under the host name "localhost".
  case "$host" in %2[Ff]* | /*) host=localhost ;; esac
  [ -n "$user" ] && [ -n "$pw" ] && [ -n "$host" ] && [ -n "$port" ] && [ -n "$db" ] || die "$url_file is not postgres://user:password@host:port/db"
  out="$dir/pgpass"
  (umask 077 && printf '%s:%s:%s:%s:%s\n' "$(pgpass_escape "$host")" "$(pgpass_escape "$port")" "$(pgpass_escape "$db")" "$(pgpass_escape "$user")" "$(pgpass_escape "$pw")" >"$out")
  echo "$out"
}
