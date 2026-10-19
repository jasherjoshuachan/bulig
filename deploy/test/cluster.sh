#!/usr/bin/env bash
# Tests for setup-cluster.sh and install_root_file, with a throwaway root and stubbed Postgres tools. They prove:
#   - the cluster has NO TCP listener (listen_addresses = ''), its logins live in a file of its own (hba_file) with only unix-socket rules,
#     and the URL handed to the kernel names the socket folder as its host and the port;
#   - the Postgres config files are written root-owned beside the target (install -o root, then mv -T), never through a link;
#   - a re-run keeps the password, rewrites nothing and restarts nothing.
# shellcheck disable=SC1091,SC2030,SC2031,SC2154
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

stubs="$work/stubs"
log="$work/log"
mkdir -p "$stubs" "$log"
export STUB_LOG="$log"
root="$work/host"
export BULIG_DEPLOY_TEST_ROOT="$root"

cat >"$stubs/pg_lsclusters" <<'STUB'
#!/usr/bin/env bash
[ -f "$STUB_LOG/clusters" ] && cat "$STUB_LOG/clusters"
exit 0
STUB
cat >"$stubs/pg_createcluster" <<'STUB'
#!/usr/bin/env bash
echo "pg_createcluster $*" >>"$STUB_LOG/calls"
mkdir -p "$BULIG_DEPLOY_TEST_ROOT/etc/postgresql/16/bulig/conf.d"
echo "16 bulig 5436 down postgres /x /y" >"$STUB_LOG/clusters"
STUB
cat >"$stubs/pg_ctlcluster" <<'STUB'
#!/usr/bin/env bash
echo "pg_ctlcluster $*" >>"$STUB_LOG/calls"
echo "16 bulig 5436 online postgres /x /y" >"$STUB_LOG/clusters"
STUB
cat >"$stubs/pg_isready" <<'STUB'
#!/usr/bin/env bash
echo "pg_isready $*" >>"$STUB_LOG/calls"
STUB
cat >"$stubs/ss" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat >"$stubs/setpriv" <<'STUB'
#!/usr/bin/env bash
shift 3
exec "$@"
STUB
cat >"$stubs/psql" <<'STUB'
#!/usr/bin/env bash
echo "psql $*" >>"$STUB_LOG/calls"
case " $* " in *" -f - "*) cat >>"$STUB_LOG/psql-stdin" ;; esac
exit 0
STUB
# mv without -T (this Mac has none), keeping its meaning
cat >"$stubs/mv" <<'STUB'
#!/usr/bin/env bash
args=(); t=0
for a in "$@"; do if [ "$a" = "-T" ]; then t=1; else args+=("$a"); fi; done
echo "mv $*" >>"$STUB_LOG/mv"
if [ "$t" -eq 1 ] && [ -L "${args[1]}" ]; then rm -f "${args[1]}"; fi
exec /bin/mv "${args[@]}"
STUB
chmod +x "$stubs"/*
export PATH="$stubs:/usr/bin:/bin:/usr/sbin:/sbin"

rm -rf "$root"
mkdir -p "$root/etc/bulig" "$root/usr/lib/postgresql/16/bin" "$root/var/lib" "$root/etc/postgresql"
chmod 700 "$root/etc/bulig"
conf="$root/etc/postgresql/16/bulig/conf.d/bulig.conf"
hba="$root/etc/postgresql/16/bulig/bulig_hba.conf"

echo "setup-cluster.sh"
expect_ok "the cluster is set up" bash "$deploy/setup-cluster.sh"
if grep -qx "listen_addresses = ''" "$conf"; then ok "the cluster has no TCP listener (listen_addresses = '')"; else bad "conf: $(cat "$conf" 2>&1)"; fi
if grep -qx "port = 5436" "$conf" && grep -qx "hba_file = '/etc/postgresql/16/bulig/bulig_hba.conf'" "$conf" && grep -qx "password_encryption = 'scram-sha-256'" "$conf"; then ok "port 5436, its own hba_file and scram-sha-256"; else bad "conf: $(cat "$conf")"; fi
rules="$(grep -vE '^#|^$' "$hba")"
if [ "$(printf '%s\n' "$rules" | wc -l | tr -d ' ')" = "3" ] && ! grep -qv '^local ' <<<"$rules"; then ok "the login rules are three unix-socket lines and nothing else (no host line, so no TCP login)"; else bad "hba: $rules"; fi
case "$rules" in *"local   all       postgres                  peer"*"local   bulig     bulig                     scram-sha-256"*"local   all       bulig_drill               scram-sha-256"*) ok "postgres by peer, bulig and bulig_drill by password" ;; *) bad "hba rules: $rules" ;; esac
url="$(cat "$root/etc/bulig/pg-url")"
case "$url" in postgres://bulig:*@%2Fvar%2Frun%2Fpostgresql:5436/bulig) ok "pg-url names the socket folder as its host, with the port" ;; *) bad "pg-url: $url" ;; esac
case "$url" in *127.0.0.1* | *localhost*) bad "pg-url mentions a TCP host: $url" ;; *) ok "pg-url has no TCP host in it" ;; esac
if [ "$(mode "$root/etc/bulig/pg-url")" = "600" ] && [ "$(mode "$root/etc/bulig/drill-pw")" = "600" ]; then ok "pg-url and drill-pw are mode 600"; else bad "credential modes"; fi
if grep -q "psql .* -h /var/run/postgresql -p 5436 -U bulig -d bulig " "$log/calls" && ! grep -q -- "-h 127.0.0.1" "$log/calls"; then ok "the login test uses the socket, not 127.0.0.1"; else bad "psql calls: $(grep psql "$log/calls" | tail -2)"; fi
if [ "$(mode "$conf")" = "644" ] && [ "$(mode "$hba")" = "644" ]; then ok "both config files are mode 644"; else bad "config modes: $(mode "$conf") $(mode "$hba")"; fi
pw1="${url#postgres://bulig:}"
pw1="${pw1%%@*}"

echo "a second run"
rm -f "$log/calls"
expect_ok "setup-cluster.sh runs again" bash "$deploy/setup-cluster.sh"
url2="$(cat "$root/etc/bulig/pg-url")"
pw2="${url2#postgres://bulig:}"
pw2="${pw2%%@*}"
if [ "$pw1" = "$pw2" ]; then ok "the password is kept"; else bad "the password changed"; fi
if ! grep -q "pg_ctlcluster .* restart" "$log/calls" && ! grep -q "pg_createcluster" "$log/calls"; then ok "nothing is restarted or created again"; else bad "calls: $(cat "$log/calls")"; fi
: >"$log/mv"
bash "$deploy/setup-cluster.sh" >/dev/null 2>&1
if ! grep -q "etc/postgresql" "$log/mv"; then ok "and no config file is rewritten when it already says the same"; else bad "mv calls on an unchanged run: $(grep etc/postgresql "$log/mv")"; fi

echo "a link at a config file"
rm -f "$log/calls"
victim="$work/victim"
echo "precious" >"$victim"
rm -f "$hba"
ln -s "$victim" "$hba"
expect_fail_msg "a link where the hba file belongs is refused" "is a link" bash "$deploy/setup-cluster.sh"
if [ "$(cat "$victim")" = "precious" ]; then ok "and the target of the link is untouched"; else bad "the link target changed"; fi
rm -f "$hba" "$conf"
ln -s "$victim" "$conf"
expect_fail_msg "a link where bulig.conf belongs is refused" "is a link" bash "$deploy/setup-cluster.sh"
if [ "$(cat "$victim")" = "precious" ]; then ok "and that target is untouched too"; else bad "the link target changed"; fi
rm -f "$conf"

echo "install_root_file"
# as root: install -o root -g root -m 0644 into a temp name beside the target, then mv -T over it. The stand-ins let that run as a normal
# user: id says 0, chown does nothing, and install records its arguments and drops the owner flags before calling the real one.
cat >"$stubs/install" <<'STUB'
#!/usr/bin/env bash
echo "install $*" >>"$STUB_LOG/install"
rest=()
skip=0
for a in "$@"; do
  if [ "$skip" -eq 1 ]; then skip=0; continue; fi
  case "$a" in -o | -g) skip=1 ;; *) rest+=("$a") ;; esac
done
/usr/bin/install "${rest[@]}" || exit $?
# a link swapped in at the target after the first check (the race the second look is for)
if [ -n "${STUB_SWAP_DEST:-}" ]; then ln -sf "$STUB_SWAP_VICTIM" "$STUB_SWAP_DEST"; fi
STUB
cat >"$stubs/id" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-u" ]; then echo 0; else exit 1; fi
STUB
cat >"$stubs/chown" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$stubs/install" "$stubs/id" "$stubs/chown"
rm -f "$log/install" "$log/mv"
mkdir -p "$root/etc/pgtest" "$root/var/lib/bulig-checks"
chmod 700 "$root/var/lib/bulig-checks"
echo "content" | bash -c ". '$deploy/lib/common.sh'; install_root_file '$root/etc/pgtest/x.conf'"
if [ "$(cat "$root/etc/pgtest/x.conf" 2>/dev/null)" = "content" ]; then ok "the content arrives"; else bad "x.conf: $(cat "$root/etc/pgtest/x.conf" 2>&1)"; fi
if grep -q -- "-o root -g root -m 0644" "$log/install"; then ok "it is installed with -o root -g root -m 0644"; else bad "install calls: $(cat "$log/install" 2>&1)"; fi
if grep -q "^mv -T .*x.conf.new\.[0-9]* .*x.conf" "$log/mv"; then ok "and renamed over the target with mv -T"; else bad "mv calls: $(cat "$log/mv" 2>&1)"; fi
if [ -z "$(find "$root/etc/pgtest" -name '*.new.*')" ] && [ -z "$(find "$root/var/lib/bulig-checks" -name 'conf.*')" ]; then ok "no temp files are left"; else bad "leftovers"; fi
ln -s "$victim" "$root/etc/pgtest/y.conf"
expect_fail_msg "a link at the target is refused" "is a link" bash -c "echo content | ( . '$deploy/lib/common.sh'; install_root_file '$root/etc/pgtest/y.conf' )"
echo "precious" >"$work/victim2"
expect_fail_msg "a link swapped in just before the rename is caught" "became a link" env STUB_SWAP_DEST="$root/etc/pgtest/race.conf" STUB_SWAP_VICTIM="$work/victim2" bash -c "echo content | ( . '$deploy/lib/common.sh'; install_root_file '$root/etc/pgtest/race.conf' )"
if [ "$(cat "$work/victim2")" = "precious" ] && [ -z "$(find "$root/etc/pgtest" -name 'race.conf.new.*')" ]; then ok "and the link's target is untouched and no temp file is left"; else bad "after the race: $(cat "$work/victim2") $(find "$root/etc/pgtest" -name 'race*')"; fi
mkdir -p "$root/var/lib/bulig/inner"
expect_fail_msg "a folder inside a user's home is refused" "inside a Bulig user's folder" bash -c "echo content | ( . '$deploy/lib/common.sh'; install_root_file '$root/var/lib/bulig/inner/z.conf' )"
ln -s "$root/etc/pgtest" "$root/etc/pglink"
expect_fail_msg "a link as the folder is refused" "missing (or is a link)" bash -c "echo content | ( . '$deploy/lib/common.sh'; install_root_file '$root/etc/pglink/w.conf' )"

finish
