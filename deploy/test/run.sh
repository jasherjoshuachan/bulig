#!/usr/bin/env bash
# Tests for the deploy kit that can run on the Mac (no root, no server):
#   1. set-secret.sh, precheck.sh and postcheck.sh refuse anything but their fixed files, and never create or re-mode a folder.
#   2. the snapshot ignores Bulig's own changes and catches changes to everything else it lists, end to end through precheck/postcheck.
# usage: bash deploy/test/run.sh        Exit 0 only if every check passes.
# The scripts run against a throwaway folder (BULIG_DEPLOY_TEST_ROOT) and fake system tools; nothing real is touched.
# shellcheck disable=SC1091,SC2030,SC2031
set -uo pipefail
# No test may wait on a terminal: a refusal that falls through to reading stdin must fail, not hang.
exec </dev/null
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy="$(dirname "$here")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
pass=0
fail=0

ok() { pass=$((pass + 1)); echo "  ok    $1"; }
bad() { fail=$((fail + 1)); echo "  FAIL  $1"; }
expect_ok() {
  local label="$1"
  shift
  if "$@" >"$work/out" 2>&1; then ok "$label"; else bad "$label: $(head -c 300 "$work/out")"; fi
}
expect_fail() {
  local label="$1"
  shift
  if "$@" >"$work/out" 2>&1; then bad "$label (it succeeded)"; else ok "$label"; fi
}
# expect_fail_msg <label> <text the output must contain> <command...>: the command must fail AND say why. A refusal that fails for another
# reason (a missing folder, a typo in the test) does not count.
expect_fail_msg() {
  local label="$1" want="$2"
  shift 2
  if "$@" >"$work/out" 2>&1; then bad "$label (it succeeded)"; elif grep -qF -- "$want" "$work/out"; then ok "$label"; else bad "$label (failed, but not with '$want'): $(head -c 300 "$work/out")"; fi
}
mode() { if /usr/bin/stat -c %a "$1" >/dev/null 2>&1; then stat -c %a "$1"; else /usr/bin/stat -f %Lp "$1"; fi; }

# ---------- 1. set-secret.sh ----------
echo "set-secret.sh"
root="$work/root1"
mkdir -p "$root/etc/bulig" "$root/tmp"
chmod 755 "$root/etc" "$root/tmp"
chmod 700 "$root/etc/bulig"
export BULIG_DEPLOY_TEST_ROOT="$root"
ss="$deploy/set-secret.sh"

expect_ok "credential pg-url is written" bash -c "printf 'postgres://bulig:x@127.0.0.1:5436/bulig\n' | '$ss' --credential pg-url"
if [ "$(cat "$root/etc/bulig/pg-url")" = "postgres://bulig:x@127.0.0.1:5436/bulig" ]; then ok "the value is stored without the newline"; else bad "pg-url content"; fi
if [ "$(mode "$root/etc/bulig/pg-url")" = "600" ]; then ok "the file is mode 600"; else bad "pg-url mode is $(mode "$root/etc/bulig/pg-url")"; fi
# /etc/bulig exists here and pg-url was just written with the same command, so each refusal below is about the name or the arguments only.
expect_fail_msg "unknown credential name is refused" "unknown credential 'bogus'" bash -c "echo v | '$ss' --credential bogus"
expect_fail_msg "a path-like credential name is refused" "unknown credential '../../tmp/evil'" bash -c "echo v | '$ss' --credential ../../tmp/evil"
expect_fail_msg "an absolute path as the name is refused" "unknown credential '/tmp/evil'" bash -c "echo v | '$ss' --credential /tmp/evil"
expect_fail_msg "an old-style NAME FILE call is refused" "usage: set-secret.sh" bash -c "echo v | '$ss' R2_BUCKET '$root/tmp/evil'"
expect_fail_msg "a third argument is refused" "usage: set-secret.sh" bash -c "echo v | '$ss' --credential pg-url '$root/tmp/evil'"
expect_fail_msg "no arguments is refused" "usage: set-secret.sh" bash -c "echo v | '$ss'"
for n in pg-url gh-token worker-tokens claude-token worker-token drill-pw; do
  expect_ok "the known credential $n is accepted" bash -c "echo v | '$ss' --credential $n"
done
expect_ok "backup key R2_BUCKET is written" bash -c "echo mybucket | '$ss' --backup-key R2_BUCKET"
expect_ok "a second backup key keeps the first" bash -c "echo https://x.example | '$ss' --backup-key R2_ENDPOINT"
if grep -qx 'R2_BUCKET=mybucket' "$root/etc/bulig/backup.env" && grep -qx 'R2_ENDPOINT=https://x.example' "$root/etc/bulig/backup.env"; then ok "both backup keys are in the file"; else bad "backup.env content"; fi
expect_ok "setting a key again replaces it" bash -c "echo other | '$ss' --backup-key R2_BUCKET"
if [ "$(grep -c '^R2_BUCKET=' "$root/etc/bulig/backup.env")" = "1" ] && grep -qx 'R2_BUCKET=other' "$root/etc/bulig/backup.env"; then ok "one R2_BUCKET line, new value"; else bad "R2_BUCKET replace"; fi
expect_fail_msg "an unknown backup key is refused" "unknown backup setting 'PATH'" bash -c "echo v | '$ss' --backup-key PATH"
expect_fail_msg "a multi-line backup value is refused" "more than one line" bash -c "printf 'a\nb\n' | '$ss' --backup-key R2_BUCKET"
if [ -z "$(ls -A "$root/tmp")" ]; then ok "nothing was written to the fake /tmp"; else bad "the fake /tmp has files: $(ls -A "$root/tmp")"; fi
if [ "$(mode "$root/etc")" = "755" ] && [ "$(mode "$root/etc/bulig")" = "700" ]; then ok "folder modes are unchanged"; else bad "a folder mode changed"; fi
if [ -z "$(find "$root/etc/bulig" -name '.*' -type f)" ]; then ok "no temp files left behind"; else bad "temp files left in $root/etc/bulig"; fi

rm -rf "$root/etc/bulig"
expect_fail_msg "a missing /etc/bulig is refused" "is missing" bash -c "echo v | '$ss' --credential pg-url"
if [ ! -e "$root/etc/bulig" ]; then ok "and it was not created"; else bad "/etc/bulig was created"; fi

# ---------- 1b. passfile ----------
echo "pg_passfile"
mkdir -p "$work/pw"
printf 'postgres://bulig:ab:c\\d@127.0.0.1:5436/bulig' >"$work/pw/url"
pf="$(. "$deploy/lib/common.sh"; pg_passfile "$work/pw/url" "$work/pw")"
if [ "$(cat "$pf")" = '127.0.0.1:5436:bulig:bulig:ab\:c\\d' ]; then ok "the password line has the host, port, db and user, with : and backslash escaped"; else bad "passfile content: $(cat "$pf")"; fi
if [ "$(mode "$pf")" = "600" ]; then ok "the passfile is mode 600"; else bad "passfile mode $(mode "$pf")"; fi
printf 'mysql://x:y@h:1/d' >"$work/pw/bad"
expect_fail "a URL that is not postgres:// is refused" bash -c ". '$deploy/lib/common.sh'; pg_passfile '$work/pw/bad' '$work/pw'"
if grep -nE 'pg_dump|pg_restore|psql' "$deploy"/backup-postgres.sh "$deploy"/restore-drill.sh "$deploy"/health.sh | grep -E 'postgres(ql)?://|pg_url|BULIG_PG_URL'; then bad "a script puts the database URL on a command line"; else ok "no script passes the database URL to a postgres tool"; fi

# ---------- 2. snapshot ----------
echo "snapshot, precheck and postcheck"
stubs="$work/stubs"
mkdir -p "$stubs"
cat >"$stubs/systemctl" <<'STUB'
#!/usr/bin/env bash
d="$STUB_DATA"
case "$1" in
  list-units) if printf '%s ' "$@" | grep -q -- '--state=running'; then awk '$4 == "running"' "$d/units.txt"; else cat "$d/units.txt"; fi ;;
  list-timers) cat "$d/timers.txt" ;;
  list-unit-files) cat "$d/unitfiles.txt" ;;
  *) exit 0 ;;
esac
STUB
cat >"$stubs/ss" <<'STUB'
#!/usr/bin/env bash
cat "$STUB_DATA/ss.txt"
STUB
cat >"$stubs/pg_lsclusters" <<'STUB'
#!/usr/bin/env bash
cat "$STUB_DATA/clusters.txt"
STUB
cat >"$stubs/getent" <<'STUB'
#!/usr/bin/env bash
cat "$STUB_DATA/$1.txt"
STUB
cat >"$stubs/crontab" <<'STUB'
#!/usr/bin/env bash
if [ -f "$STUB_DATA/crontab.txt" ]; then cat "$STUB_DATA/crontab.txt"; else exit 1; fi
STUB
cat >"$stubs/stat" <<'STUB'
#!/usr/bin/env bash
cat "$STUB_DATA/stat.txt"
STUB
# A fast stand-in for sha256sum (it only has to change when the content changes): "<cksum> <size>  <name>", same shape as the real output.
cat >"$stubs/sha256sum" <<'STUB'
#!/usr/bin/env bash
if [ "$#" -eq 0 ]; then echo "$(cksum | tr ' ' '-')  -"; exit 0; fi
for f in "$@"; do echo "$(cksum <"$f" | tr ' ' '-')  $f"; done
STUB
chmod +x "$stubs"/*

# The fakes come first on PATH. mode() above ran already, so the fake stat does not matter to it.
export PATH="$stubs:/usr/bin:/bin:/usr/sbin:/sbin"

new_world() {
  # A fresh fake host in $1 with some client production on it.
  local w="$1"
  rm -rf "$w"
  mkdir -p "$w/data" "$w/root/etc/systemd/system/multi-user.target.wants" "$w/root/etc/cron.d" "$w/root/etc/postgresql/16/main" "$w/root/var/lib"
  cat >"$w/data/units.txt" <<'DATA'
nginx.service loaded active running A web server
clientapp.service loaded active running Client app
cron.service loaded active running Cron
DATA
  cat >"$w/data/timers.txt" <<'DATA'
Mon 2026-10-19 10:00:00 UTC 1h left Mon 2026-10-19 09:00:00 UTC 1min ago logrotate.timer logrotate.service
Mon 2026-10-19 11:00:00 UTC 2h left Mon 2026-10-19 10:00:00 UTC 1min ago clientjob.timer clientjob.service
DATA
  cat >"$w/data/unitfiles.txt" <<'DATA'
nginx.service enabled
clientapp.service enabled
cron.service enabled
DATA
  cat >"$w/data/ss.txt" <<'DATA'
LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))
LISTEN 0 200 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=900,fd=5))
DATA
  printf '16 main 5432 online postgres /var/lib/postgresql/16/main /var/log/postgresql/postgresql-16-main.log\n' >"$w/data/clusters.txt"
  printf 'root:x:0:0:root:/root:/bin/bash\nclient:x:1000:1000::/home/client:/bin/bash\n' >"$w/data/passwd.txt"
  printf 'root:x:0:\nclient:x:1000:\n' >"$w/data/group.txt"
  printf '0 3 * * * /usr/local/bin/client-backup\n' >"$w/data/crontab.txt"
  printf '755 root root /\n755 root root /etc\n1777 root root /tmp\n755 root root /opt\n755 root root /var/lib\n755 root root /var/backups\n755 root root /run\n' >"$w/data/stat.txt"
  echo "ExecStart=/bin/true" >"$w/root/etc/systemd/system/clientapp.service"
  echo "listen_addresses = '*'" >"$w/root/etc/postgresql/16/main/postgresql.conf"
  echo "0 3 * * * root /usr/local/bin/x" >"$w/root/etc/cron.d/client"
  ln -s /etc/systemd/system/clientapp.service "$w/root/etc/systemd/system/multi-user.target.wants/clientapp.service"
}

take() { # take <world>: print a snapshot of that world
  (
    export STUB_DATA="$1/data" BULIG_DEPLOY_TEST_ROOT="$1/root"
    # shellcheck source=../lib/common.sh
    . "$deploy/lib/common.sh"
    # shellcheck source=../lib/snapshot.sh
    . "$deploy/lib/snapshot.sh"
    snapshot
  )
}

w="$work/w"
new_world "$w"
take "$w" >"$work/base.txt"
if [ -s "$work/base.txt" ]; then ok "a snapshot is produced"; else bad "empty snapshot"; fi
if grep -q 'clientapp.service' "$work/base.txt" && grep -q 'client:x:1000' "$work/base.txt" && grep -q 'clientjob.timer' "$work/base.txt"; then ok "it lists client services, users and timers"; else bad "snapshot misses client things"; fi

# Bulig's own additions must not change it.
cat >>"$w/data/units.txt" <<'DATA'
bulig.service loaded active running Bulig kernel
bulig-worker.service loaded active running Bulig worker
postgresql@16-bulig.service loaded active running PostgreSQL 16 bulig
DATA
echo 'Tue 2026-10-20 03:15:00 UTC 17h left n/a n/a bulig-backup.timer bulig-backup.service' >>"$w/data/timers.txt"
printf 'bulig.service enabled\nbulig-worker.service enabled\n' >>"$w/data/unitfiles.txt"
echo 'LISTEN 0 200 127.0.0.1:5436 0.0.0.0:* users:(("postgres",pid=1234,fd=5))' >>"$w/data/ss.txt"
echo 'LISTEN 0 128 100.64.0.9:7431 0.0.0.0:* users:(("node",pid=1300,fd=19))' >>"$w/data/ss.txt"
echo '16 bulig 5436 online postgres /var/lib/postgresql/16/bulig /var/log/postgresql/postgresql-16-bulig.log' >>"$w/data/clusters.txt"
printf 'bulig:x:998:998::/var/lib/bulig:/usr/sbin/nologin\nbulig-worker:x:997:997::/var/lib/bulig-worker:/usr/sbin/nologin\n' >>"$w/data/passwd.txt"
printf 'bulig:x:998:\nbulig-worker:x:997:\n' >>"$w/data/group.txt"
echo "x" >"$w/root/etc/systemd/system/bulig.service"
echo "x" >"$w/root/etc/systemd/system/bulig-backup.timer"
ln -s /etc/systemd/system/bulig.service "$w/root/etc/systemd/system/multi-user.target.wants/bulig.service"
mkdir -p "$w/root/etc/postgresql/16/bulig"
echo "port = 5436" >"$w/root/etc/postgresql/16/bulig/postgresql.conf"
echo "0 0 * * * root true" >"$w/root/etc/cron.d/bulig-x"
take "$w" >"$work/with-bulig.txt"
if diff -u "$work/base.txt" "$work/with-bulig.txt" >"$work/d.txt"; then ok "Bulig's users, units, timers, cluster, port and files do not change the snapshot"; else bad "Bulig's own things show up: $(head -20 "$work/d.txt")"; fi

# Anything else must change it. One change per fresh world.
check_change() { # check_change <label> <command run inside the world folder>
  local label="$1" cmd="$2" cw="$work/cw"
  new_world "$cw"
  take "$cw" >"$work/before.txt"
  (cd "$cw" && eval "$cmd")
  take "$cw" >"$work/after.txt"
  if diff -q "$work/before.txt" "$work/after.txt" >/dev/null; then bad "not caught: $label"; else ok "caught: $label"; fi
}
check_change "a new running service" "echo 'newthing.service loaded active running New' >>data/units.txt"
check_change "a client service stopped" "sed -i.bak 's/clientapp.service loaded active running/clientapp.service loaded inactive dead/' data/units.txt"
check_change "a new timer" "echo 'Tue 2026-10-20 01:00:00 UTC 1h left n/a n/a evil.timer evil.service' >>data/timers.txt"
check_change "a new listening port" "echo 'LISTEN 0 1 0.0.0.0:8080 0.0.0.0:* users:((\"python3\",pid=7,fd=3))' >>data/ss.txt"
check_change "another cluster" "echo '16 other 5437 online postgres /x /y' >>data/clusters.txt"
check_change "a new user" "echo 'mallory:x:1001:1001::/home/mallory:/bin/bash' >>data/passwd.txt"
check_change "a new group" "echo 'wheel2:x:1002:' >>data/group.txt"
check_change "a changed crontab" "echo '* * * * * evil' >>data/crontab.txt"
check_change "a new /etc/cron.d file" "echo '* * * * * root evil' >root/etc/cron.d/evil"
check_change "an edited unit file under /etc/systemd/system" "echo 'ExecStart=/bin/evil' >>root/etc/systemd/system/clientapp.service"
check_change "a new unit file under /etc/systemd/system" "echo x >root/etc/systemd/system/evil.service"
check_change "a new enable link under /etc/systemd/system" "ln -s /etc/systemd/system/evil.service root/etc/systemd/system/multi-user.target.wants/evil.service"
check_change "an edited postgresql config of another cluster" "echo 'fsync = off' >>root/etc/postgresql/16/main/postgresql.conf"
check_change "/tmp changed mode" "sed -i.bak 's#^1777 root root /tmp#700 root root /tmp#' data/stat.txt"
check_change "/etc changed mode" "sed -i.bak 's#^755 root root /etc\$#700 root root /etc#' data/stat.txt"

# precheck.sh then postcheck.sh, end to end.
new_world "$w"
export STUB_DATA="$w/data" BULIG_DEPLOY_TEST_ROOT="$w/root"
expect_ok "precheck.sh runs" bash "$deploy/precheck.sh"
checks="$w/root/var/lib/bulig-checks"
if [ -f "$checks/precheck.snapshot" ] && [ "$(mode "$checks")" = "700" ]; then ok "it wrote one file in a 0700 folder of its own"; else bad "precheck output"; fi
# The same fixture that makes the no-argument run succeed must make the run with an argument fail, and for the stated reason.
expect_fail_msg "precheck.sh with an argument is refused" "takes no arguments" bash "$deploy/precheck.sh" "$w/root/tmp-elsewhere"
expect_ok "postcheck.sh passes when nothing changed" bash "$deploy/postcheck.sh"
expect_fail_msg "postcheck.sh with an argument is refused" "takes no arguments" bash "$deploy/postcheck.sh" "$w/root/tmp-elsewhere"
if [ ! -e "$w/root/tmp-elsewhere" ]; then ok "neither script touched the path it was given"; else bad "a script created the path it was given"; fi
echo 'LISTEN 0 1 0.0.0.0:8080 0.0.0.0:* users:(("python3",pid=7,fd=3))' >>"$w/data/ss.txt"
expect_fail_msg "postcheck.sh fails after a change, and shows it" "8080" bash "$deploy/postcheck.sh"
if [ "$(find "$checks" -type f | wc -l | tr -d ' ')" = "1" ]; then ok "postcheck left no temp files"; else bad "postcheck left extra files in $checks"; fi

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
