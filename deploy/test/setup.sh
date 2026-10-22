#!/usr/bin/env bash
# Tests for the setup scripts and the guards under them, with a throwaway root and stubbed system tools. They prove:
#   - a setup script refuses to run while any process of either Bulig user exists, and changes nothing when it refuses;
#   - setup creates the users with --no-create-home and creates NO folder for either user (systemd does, from StateDirectory=);
#   - every folder setup makes is root's, under a root-owned parent, with the right mode, and a second run changes nothing;
#   - a link where a root folder belongs is refused, not followed, and every chown carries -h;
#   - need_dir refuses a path inside a user's folder, and (as real root) a path with a parent that is not root's or is writable by others.
# shellcheck disable=SC1091,SC2030,SC2031,SC2154
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

stubs="$work/stubs"
log="$work/log"
mkdir -p "$stubs" "$log"
export STUB_LOG="$log"

# the machine's addresses, as `ip -o addr show scope global` prints them on ths-prod-01
cat >"$stubs/ip" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"scope global"*)
    cat <<'DATA'
2: eth0    inet 203.0.113.10/32 metric 100 scope global dynamic eth0
2: eth0    inet6 2001:db8::10/64 scope global
6: tailscale0    inet 100.64.0.10/32 scope global tailscale0  scan-forbidden: allow-addresses (a Tailscale test address)
7: docker0    inet 172.16.0.1/16 brd 172.16.255.255 scope global docker0
DATA
    ;;
esac
STUB
# install that drops -o/-g (the tests run as a normal user while the id stand-in says root)
cat >"$stubs/install" <<'STUB'
#!/usr/bin/env bash
rest=(); skip=0
for a in "$@"; do
  if [ "$skip" -eq 1 ]; then skip=0; continue; fi
  case "$a" in -o | -g) skip=1 ;; *) rest+=("$a") ;; esac
done
exec /usr/bin/install "${rest[@]}"
STUB
# mv without -T (this Mac has none), keeping its meaning
cat >"$stubs/mv" <<'STUB'
#!/usr/bin/env bash
args=(); t=0
for a in "$@"; do if [ "$a" = "-T" ]; then t=1; else args+=("$a"); fi; done
if [ "$t" -eq 1 ] && [ -L "${args[1]}" ]; then rm -f "${args[1]}"; fi
exec /bin/mv "${args[@]}"
STUB
cat >"$stubs/id" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-u" ]; then echo 0; exit 0; fi
for u in ${STUB_USERS:-} $(cat "$STUB_LOG/created-users" 2>/dev/null); do [ "$u" = "$1" ] && exit 0; done
exit 1
STUB
cat >"$stubs/pgrep" <<'STUB'
#!/usr/bin/env bash
echo "pgrep $*" >>"$STUB_LOG/calls"
for u in ${STUB_RUNNING:-}; do [ "$u" = "$2" ] && exit 0; done
exit 1
STUB
cat >"$stubs/useradd" <<'STUB'
#!/usr/bin/env bash
echo "useradd $*" >>"$STUB_LOG/calls"
for a in "$@"; do last="$a"; done
echo "$last" >>"$STUB_LOG/created-users"
STUB
cat >"$stubs/getent" <<'STUB'
#!/usr/bin/env bash
echo "getent $*" >>"$STUB_LOG/getent"
name="$2"
var="STUB_HOME_${name//-/_}"
echo "$name:x:999:999::${!var:-/var/lib/$name}:/usr/sbin/nologin"
STUB
cat >"$stubs/runuser" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"--version"*) echo "v22.1.0" ;;
  *"command -v "*) echo "/usr/bin/${*##*command -v }" ;;
esac
STUB
# chown that records its arguments, and follows a link unless it gets -h (the way the real one does), by leaving a mark in the target.
cat >"$stubs/chown" <<'STUB'
#!/usr/bin/env bash
echo "chown $*" >>"$STUB_LOG/chown"
h=0; args=()
for a in "$@"; do if [ "$a" = "-h" ]; then h=1; else args+=("$a"); fi; done
target="${args[1]}"
if [ "$h" -eq 0 ] && [ -L "$target" ]; then echo "followed" >"$STUB_LOG/followed"; fi
exit 0
STUB
# stat for need_dir's walk as root: "%u %a" from a table "path owner mode" (default: root 755).
cat >"$stubs/stat" <<'STUB'
#!/usr/bin/env bash
path="${*: -1}"
while read -r p o m; do
  if [ "$p" = "$path" ]; then echo "$o $m"; exit 0; fi
done <"${STUB_STAT_TABLE:-/dev/null}"
echo "0 755"
STUB
chmod +x "$stubs"/*
export PATH="$stubs:/usr/bin:/bin:/usr/sbin:/sbin"

new_root() { # new_root <dir>: a fake host with the root-owned parents the setup scripts expect
  rm -rf "${1:?}" "${log:?}"/*
  mkdir -p "$1/opt" "$1/usr/local/lib" "$1/etc/systemd/system" "$1/var/backups" "$1/var/lib"
}
listing() { (cd "$1" && find . | sort); }

root="$work/host"
export BULIG_DEPLOY_TEST_ROOT="$root"
su="$deploy/setup-user.sh"

# --- 1. refusals while a user's process exists ---
echo "setup refuses while a Bulig process exists"
new_root "$root"
before="$(listing "$root")"
export STUB_USERS="bulig bulig-worker"
export STUB_RUNNING="bulig"
expect_fail_msg "setup-user.sh refuses while a kernel process exists" "processes of user bulig are running" bash "$su"
expect_fail_msg "setup-user.sh refuses while a worker process exists" "processes of user bulig-worker are running" env STUB_RUNNING=bulig-worker bash "$su"
expect_fail_msg "setup-cluster.sh refuses too" "processes of user bulig are running" bash "$deploy/setup-cluster.sh"
if [ "$(listing "$root")" = "$before" ] && ! grep -q '^useradd' "$log/calls"; then ok "a refusal creates and changes nothing"; else bad "something changed during a refusal: $(listing "$root")"; fi
if grep -q '^pgrep -u bulig' "$log/calls" && grep -q '^pgrep -u bulig-worker' "$log/calls"; then ok "it asks pgrep about both users by name"; else bad "pgrep calls: $(cat "$log/calls")"; fi

# --- 2. a normal setup ---
echo "setup-user.sh"
new_root "$root"
unset STUB_USERS STUB_RUNNING
expect_ok "setup runs when no Bulig process exists" bash "$su"
for pair in "opt/bulig 755" "opt/bulig/releases 755" "usr/local/lib/bulig 755" "etc/bulig 700" "var/backups/bulig 700" "var/lib/bulig-checks 700" "var/lib/bulig-checks/docker 700"; do
  read -r dir_ want_ <<<"$pair"
  if [ -d "$root/$dir_" ] && [ "$(mode "$root/$dir_")" = "$want_" ]; then ok "/$dir_ exists with mode $want_"; else bad "/$dir_: $(mode "$root/$dir_" 2>&1)"; fi
done
if [ ! -e "$root/var/lib/bulig" ] && [ ! -e "$root/var/lib/bulig-worker" ]; then ok "NO folder was created for either user (systemd makes /var/lib/bulig and /var/lib/bulig-worker)"; else bad "a user folder was created: $(ls "$root/var/lib")"; fi
if grep -q '^useradd --system --no-create-home --home-dir /var/lib/bulig --shell /usr/sbin/nologin --user-group bulig$' "$log/calls" && grep -q '^useradd --system --no-create-home --home-dir /var/lib/bulig-worker --shell /usr/sbin/nologin --user-group bulig-worker$' "$log/calls"; then ok "both users are made with --system --no-create-home and their /var/lib home"; else bad "useradd calls: $(grep useradd "$log/calls")"; fi
if grep -q ' -h ' "$log/chown" && ! grep -qv ' -h ' "$log/chown"; then ok "every chown carries -h"; else bad "chown calls: $(cat "$log/chown" 2>&1)"; fi
if [ ! -e "$log/followed" ]; then ok "no chown followed a link"; else bad "a chown followed a link"; fi
files="$(cd "$root" && find . -type f | sort | tr '\n' ' ')"
if [ "$files" = "./etc/systemd/system/bulig-pasta.service.d/10-host-addresses.conf ./etc/systemd/system/bulig-worker.service.d/10-host-addresses.conf " ]; then ok "setup writes two files only, the worker's and pasta's host-address drop-ins (no placeholder secrets, no config)"; else bad "files created: $files"; fi
if cmp -s "$root/etc/systemd/system/bulig-worker.service.d/10-host-addresses.conf" "$root/etc/systemd/system/bulig-pasta.service.d/10-host-addresses.conf" || [ "$(grep '^IPAddressDeny=' "$root/etc/systemd/system/bulig-pasta.service.d/10-host-addresses.conf")" = "$(grep '^IPAddressDeny=' "$root/etc/systemd/system/bulig-worker.service.d/10-host-addresses.conf")" ]; then ok "and pasta's denies the same addresses as the worker's (the worker's packets leave the host as pasta's)"; else bad "pasta drop-in: $(cat "$root/etc/systemd/system/bulig-pasta.service.d/10-host-addresses.conf")"; fi
if grep -qx "IPAddressDeny=2001:db8::10/128 203.0.113.10/32" "$root/etc/systemd/system/bulig-worker.service.d/10-host-addresses.conf"; then ok "and that drop-in denies the machine's own public addresses, read from ip"; else bad "drop-in: $(cat "$root/etc/systemd/system/bulig-worker.service.d/10-host-addresses.conf")"; fi

# --- 3. a second run changes nothing ---
after1="$(listing "$root")"
rm -f "$log/calls"
export STUB_USERS="bulig bulig-worker"
expect_ok "a second run works" bash "$su"
if [ "$(listing "$root")" = "$after1" ] && ! grep -q '^useradd' "$log/calls"; then ok "and changes nothing (no useradd, same folders)"; else bad "second run changed things"; fi
chmod 755 "$root/etc/bulig"
bash "$su" >/dev/null 2>&1
if [ "$(mode "$root/etc/bulig")" = "700" ]; then ok "a loosened root folder is put back to 0700"; else bad "etc/bulig mode $(mode "$root/etc/bulig")"; fi
rm -f "$log/calls" "$log/getent"
expect_ok "a user that exists with another home is left alone (the units set HOME and StateDirectory themselves)" env STUB_HOME_bulig=/home/bulig bash "$su"
if ! grep -q '^useradd' "$log/calls" && [ ! -e "$log/getent" ]; then ok "no useradd, and the home is never looked up (no getent)"; else bad "calls: $(cat "$log/calls" "$log/getent" 2>/dev/null)"; fi

# --- 4. links where a root folder belongs ---
echo "links"
new_root "$root"
unset STUB_USERS
victim="$work/victim"
mkdir -p "$victim"
chmod 777 "$victim"
ln -s "$victim" "$root/opt/bulig"
expect_fail_msg "a link in place of /opt/bulig is refused" "is a link" bash "$su"
if [ "$(mode "$victim")" = "777" ] && [ -z "$(ls -A "$victim")" ] && [ ! -e "$log/followed" ]; then ok "and it was not followed (the target is unchanged and empty)"; else bad "victim changed: $(mode "$victim") $(ls -A "$victim")"; fi
rm "$root/opt/bulig"
mkdir -p "$root/opt/bulig"
ln -s "$victim" "$root/opt/bulig/releases"
expect_fail_msg "a link in place of /opt/bulig/releases is refused" "is a link" bash "$su"
rm "$root/opt/bulig/releases"
ln -s "$victim" "$root/etc/bulig"
expect_fail_msg "a link in place of /etc/bulig is refused" "is a link" bash "$su"
if [ "$(mode "$victim")" = "777" ] && [ -z "$(ls -A "$victim")" ]; then ok "none of the three was followed"; else bad "victim changed"; fi
rm "$root/etc/bulig"
# a secret written while /etc/bulig is a link is refused too
ln -s "$victim" "$root/etc/bulig"
expect_fail_msg "a secret is not written through a link at /etc/bulig" "is missing (or is a link)" bash -c "echo v | '$deploy/set-secret.sh' --credential pg-url"
if [ -z "$(ls -A "$victim")" ]; then ok "and nothing landed in the target"; else bad "a secret landed in the link target"; fi
rm "$root/etc/bulig"

# --- 5. need_dir as real root ---
echo "need_dir as root"
real="$work/realish"
mkdir -p "$real/a/b"
nd() { env -u BULIG_DEPLOY_TEST_ROOT STUB_STAT_TABLE="$work/stat-table" bash -c ". '$deploy/lib/common.sh'; need_dir '$1'"; }
: >"$work/stat-table"
expect_ok "a folder with root-owned, unwritable parents is accepted" nd "$real/a/b"
printf '%s 998 755\n' "$(cd -P "$real/a" && pwd)" >"$work/stat-table"
expect_fail_msg "a parent owned by another user is refused" "is not owned by root" nd "$real/a/b"
printf '%s 0 775\n' "$(cd -P "$real/a" && pwd)" >"$work/stat-table"
expect_fail_msg "a parent writable by its group is refused" "writable by its group" nd "$real/a/b"
printf '%s 0 757\n' "$(cd -P "$real/a" && pwd)" >"$work/stat-table"
expect_fail_msg "a parent writable by anyone is refused" "writable by anyone" nd "$real/a/b"
printf '%s 0 1707\n' "$(cd -P "$real" && pwd)" >"$work/stat-table"
expect_fail_msg "a sticky world-writable parent (like /tmp) is refused" "writable by anyone" nd "$real/a/b"
printf '%s 0 700\n%s 0 750\n' "$(cd -P "$real/a" && pwd)" "$(cd -P "$real" && pwd)" >"$work/stat-table"
expect_ok "700 and 750 parents are accepted" nd "$real/a/b"

finish
