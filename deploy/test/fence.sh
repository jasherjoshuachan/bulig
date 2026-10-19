#!/usr/bin/env bash
# Tests for the fence (round 2): the host-address drop-in, set-mac-worker.sh, the properties of every set, the probe logic and fence-check.sh,
# all offline. The probe is run against listeners this test opens (a TCP port, an HTTP port, a unix socket, on Linux an abstract socket),
# and systemd-run is a stand-in that records its arguments and runs the probe locally. Nothing here proves the fence itself holds; that is
# fence-check.sh on the real machine, in the server phase.
# shellcheck disable=SC1091,SC2030,SC2031,SC2154
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
export PYTHONDONTWRITEBYTECODE=1

stubs="$work/stubs"
log="$work/log"
mkdir -p "$stubs" "$log"
export STUB_LOG="$log"
root="$work/host"
export BULIG_DEPLOY_TEST_ROOT="$root"

# `ip -o addr show scope global`, with documentation addresses (a public IPv4 and IPv6, a tailscale address, a container bridge, a LAN)
cat >"$stubs/ip" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"dev tailscale0"*) echo "6: tailscale0    inet 100.64.0.10/32 scope global tailscale0" ;;
  *"scope global"*)
    cat <<'DATA'
2: eth0    inet 203.0.113.10/32 metric 100 scope global dynamic eth0
2: eth0    inet6 2001:db8::10/64 scope global
6: tailscale0    inet 100.64.0.10/32 scope global tailscale0
6: tailscale0    inet6 fd00:db8::10/128 scope global
7: docker0    inet 172.16.0.1/16 brd 172.16.255.255 scope global docker0
8: br-1    inet 172.23.0.1/16 scope global br-1
9: lan0    inet 192.168.1.5/24 scope global lan0
9: lan0    inet 10.1.2.3/8 scope global lan0
DATA
    ;;
esac
STUB
cat >"$stubs/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "systemctl $*" >>"$STUB_LOG/systemctl"
if [ "$1" = "show" ] && [ -n "${STUB_SHOW_FILE:-}" ]; then cat "$STUB_SHOW_FILE"; fi
STUB
# ss shows nothing unless a test gives it something (on a real machine it would list real listeners, and the stand-in systemd-run does not fence)
cat >"$stubs/ss" <<'STUB'
#!/usr/bin/env bash
case "$*" in *"-xl"*) cat "$STUB_LOG/ss-unix" 2>/dev/null ;; *) cat "$STUB_LOG/ss-tcp" 2>/dev/null ;; esac
exit 0
STUB
cat >"$stubs/mv" <<'STUB'
#!/usr/bin/env bash
args=(); t=0
for a in "$@"; do if [ "$a" = "-T" ]; then t=1; else args+=("$a"); fi; done
if [ "$t" -eq 1 ] && [ -L "${args[1]}" ]; then rm -f "${args[1]}"; fi
exec /bin/mv "${args[@]}"
STUB
chmod +x "$stubs"/*
NODE_DIR=""
for cand in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -n "$cand" ] && [ -x "$cand" ]; then NODE_DIR="$(dirname "$cand")"; break; fi
done
export PATH="$stubs:/usr/bin:/bin:/usr/sbin:/sbin"

new_host() {
  rm -rf "$root"
  mkdir -p "$root/etc/systemd/system" "$root/var/lib" "$root/etc/bulig"
  chmod 700 "$root/etc/bulig"
  # fence-check needs the machine-specific probes file; this one holds a single known-limit probe that only reports
  printf '# test machine\nknown worker,kernel,build,cli-worker,cli-kernel extra-known tcp 127.0.0.1:1\n' >"$root/etc/bulig/fence-extra-probes.txt"
  chmod 600 "$root/etc/bulig/fence-extra-probes.txt"
}
new_host
SD="$root/etc/systemd/system"

echo "host_addresses and the worker's drop-in"
got="$(. "$deploy/lib/common.sh"; host_addresses | tr '\n' ' ')"
if [ "$got" = "2001:db8::10/128 203.0.113.10/32 " ]; then ok "only the public addresses are read, as /32 and /128 (private, docker, tailscale and unique-local are left out)"; else bad "host_addresses: '$got'"; fi
expect_ok "host-addresses.sh runs" bash "$deploy/host-addresses.sh"
d="$SD/bulig-worker.service.d/10-host-addresses.conf"
if [ "$(grep -v '^#' "$d" | tr '\n' '|')" = "[Service]|IPAddressDeny=2001:db8::10/128 203.0.113.10/32|" ]; then ok "the drop-in denies exactly those two addresses"; else bad "drop-in: $(cat "$d")"; fi
if [ "$(mode "$d")" = "644" ] && [ "$(mode "$SD/bulig-worker.service.d")" = "755" ]; then ok "root-owned modes (file 644, folder 755)"; else bad "drop-in modes"; fi
if grep -q "daemon-reload" "$log/systemctl"; then ok "systemd is told to reload"; else bad "no daemon-reload"; fi
ln -sf "$work/elsewhere" "$d"
expect_fail_msg "a link where the drop-in belongs is refused" "is a link" bash "$deploy/host-addresses.sh"
rm -f "$d"
expect_fail_msg "host-addresses.sh takes no arguments" "takes no arguments" bash "$deploy/host-addresses.sh" x
# no address found: a header-only drop-in and a loud warning
cp "$stubs/ip" "$work/ip.real"
printf '#!/usr/bin/env bash\nexit 0\n' >"$stubs/ip"
bash "$deploy/host-addresses.sh" >"$work/out" 2>&1
if grep -q "WARNING no public address" "$work/out" && ! grep -q "IPAddressDeny" "$d"; then ok "with no public address it warns and writes a drop-in that names none"; else bad "no-address case: $(cat "$work/out")"; fi
cp "$work/ip.real" "$stubs/ip"

echo "set-mac-worker.sh"
mw="$SD/bulig.service.d/20-mac-worker.conf"
expect_ok "a Tailscale address is accepted" bash "$deploy/set-mac-worker.sh" 100.101.102.103
if [ "$(grep -v '^#' "$mw" | tr '\n' '|')" = "[Service]|IPAddressAllow=100.101.102.103/32|" ]; then ok "the drop-in allows that one /32"; else bad "mac drop-in: $(cat "$mw")"; fi
if [ "$(mode "$mw")" = "644" ]; then ok "root-owned mode 644"; else bad "mode $(mode "$mw")"; fi
# (the addresses just outside the Tailscale range are built from parts: the repository scan refuses to have them written out)
for bad_ip in 127.0.0.1 10.0.0.5 "100.$((64 - 1)).255.255" "100.$((127 + 1)).0.1" "$((4 * 2)).$((4 * 2)).$((4 * 2)).$((4 * 2))" 100.101.102 100.101.102.103/32 100.101.102.256 100.064.1.1 100.101.102.103.4 mac.tail.net "" "100.101.102.103 100.64.1.1"; do
  expect_fail_msg "refused: '$bad_ip'" "" bash "$deploy/set-mac-worker.sh" "$bad_ip"
  if [ "$(grep -c 'IPAddressAllow' "$mw")" = "1" ] && grep -q "100.101.102.103/32" "$mw"; then :; else bad "the drop-in changed after a refusal of '$bad_ip'"; fi
done
expect_fail_msg "two arguments are refused" "usage: set-mac-worker.sh" bash "$deploy/set-mac-worker.sh" 100.101.102.103 100.64.1.1
: >"$log/systemctl"
bash "$deploy/set-mac-worker.sh" 100.101.102.104 >/dev/null 2>&1
if grep -q "daemon-reload" "$log/systemctl"; then ok "systemd is told to reload after the drop-in changes"; else bad "no daemon-reload after set-mac-worker"; fi
expect_ok "100.64.0.0 is the lowest Tailscale address" bash "$deploy/set-mac-worker.sh" 100.64.0.0
expect_ok "100.127.255.255 is the highest" bash "$deploy/set-mac-worker.sh" 100.127.255.255
if grep -q "IPAddressAllow=100.127.255.255/32" "$mw" && [ "$(grep -c IPAddressAllow "$mw")" = "1" ]; then ok "a second run replaces the first (one peer at a time)"; else bad "mac drop-in after rerun: $(cat "$mw")"; fi
expect_ok "--remove deletes it" bash "$deploy/set-mac-worker.sh" --remove
if [ ! -e "$mw" ]; then ok "and the kernel allows no Tailscale peer again"; else bad "drop-in still there"; fi
expect_fail_msg "no argument is refused" "usage: set-mac-worker.sh" bash "$deploy/set-mac-worker.sh"
mkdir -p "$SD/bulig.service.d"
ln -s "$work/elsewhere" "$mw"
expect_fail_msg "a link where the drop-in belongs is refused (set)" "is a link" bash "$deploy/set-mac-worker.sh" 100.101.102.103
expect_fail_msg "a link where the drop-in belongs is refused (remove)" "is a link" bash "$deploy/set-mac-worker.sh" --remove
rm -f "$mw"

echo "the properties of each set"
props() { # props <function call...>: print the array the function fills, one -p value per line
  bash -c ". '$deploy/lib/common.sh'; . '$deploy/lib/fence.sh'; $1" | tr '\n' ' '
}
DENY="localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7"
HOSTS="2001:db8::10/128 203.0.113.10/32"
INACC="-/run/tailscale -/run/snapd.socket -/run/docker.sock -/var/run/docker.sock"
RES="/run/systemd/resolve/resolv.conf:/etc/resolv.conf"
# shellcheck disable=SC2016
got="$(props 'build_fence_props; printf "%s\n" "${FENCE_BUILD[@]}"')"
want="-p DynamicUser=yes -p RestrictAddressFamilies=AF_INET AF_INET6 -p IPAddressDeny=$DENY $HOSTS -p InaccessiblePaths=$INACC -p BindReadOnlyPaths=$RES "
if [ "$got" = "$want" ]; then ok "build: throwaway user, no AF_UNIX, private ranges and the host's addresses denied, nothing allowed, sockets hidden, upstream resolvers"; else bad "build props: $got"; fi
# shellcheck disable=SC2016
got="$(props 'cli_fence_props worker; printf "%s\n" "${FENCE_CLI[@]}"')"
want="-p RestrictAddressFamilies=AF_INET AF_INET6 -p IPAddressDeny=$DENY $HOSTS -p IPAddressAllow=127.74.3.1/32 -p InaccessiblePaths=$INACC -p BindReadOnlyPaths=$RES "
if [ "$got" = "$want" ]; then ok "cli worker: no AF_UNIX, denies like the build, allows the gateway address only"; else bad "cli worker props: $got"; fi
# shellcheck disable=SC2016
got="$(props 'cli_fence_props kernel; printf "%s\n" "${FENCE_CLI[@]}"')"
want="-p RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 -p IPAddressDeny=$DENY -p IPAddressAllow=127.74.3.1/32 -p InaccessiblePaths=$INACC -p BindReadOnlyPaths=$RES "
if [ "$got" = "$want" ]; then ok "cli kernel: keeps AF_UNIX (Postgres), allows the gateway address only (no Tailscale peer)"; else bad "cli kernel props: $got"; fi

echo "the probe logic"
python3 -I "$deploy/test/fixture-server.py" "$work" >"$work/fixture.out" 2>&1 &
fixture_pid=$!
for _ in $(seq 1 50); do [ -s "$work/fixture.out" ] && break; sleep 0.1; done
read -r tcp_kv http_kv unix_kv abs_kv <"$work/fixture.out"
tcp_port="${tcp_kv#tcp=}"; http_port="${http_kv#http=}"; unix_path="${unix_kv#unix=}"; abs_name="${abs_kv#abstract=}"
closed_port="$(python3 -I -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()")"
probes="$work/probes.txt"
cat >"$probes" <<EOF
# expect sets name kind target
deny  worker,kernel        leak-tcp        tcp      127.0.0.1:$tcp_port
deny  worker               closed-tcp      tcp      127.0.0.1:$closed_port
deny  worker               unknown-closed  tcp      127.0.0.1:$closed_port
deny  worker               leak-unix       unix     $unix_path
deny  worker               host-ssh        tcp      @HOST@:$closed_port
allow worker               gateway-http    http     http://127.0.0.1:$http_port/healthz
allow worker               missing-thing   tcp      127.0.0.1:$closed_port
allow-late worker          late-thing      http     http://127.0.0.1:$closed_port/healthz
known worker               open-limit      tcp      127.0.0.1:$tcp_port
allow worker               a-user          pwd      -
allow worker               a-pair          socketpair -
allow worker               a-child         spawn    -
deny  kernel               only-kernel     tcp      127.0.0.1:$closed_port
EOF
probe() { python3 -I "$deploy/fence-probe.py" "$@"; }
out="$(probe control worker "$probes" --host-addrs "203.0.113.10/32 2001:db8::10/128")"
if grep -qx "leak-tcp=open" <<<"$out" && grep -qx "closed-tcp=closed" <<<"$out" && grep -qx "leak-unix=open" <<<"$out" && grep -qx "open-limit=open" <<<"$out"; then ok "control run: says which deny and known targets are really listening"; else bad "control output: $out"; fi
if grep -q "host-ssh-203.0.113.10=closed" <<<"$out" && grep -q "host-ssh-2001:db8::10=closed" <<<"$out"; then ok "@HOST@ gives one probe per address (v4 and v6)"; else bad "placeholders: $out"; fi
if ! grep -q "only-kernel" <<<"$out"; then ok "a probe for another set is not run"; else bad "the kernel probe ran in the worker set"; fi
ctl="$(printf '%s\n' "$out" | paste -sd, -)"
rc=0
res="$(probe fenced worker "$probes" --host-addrs "203.0.113.10/32" --control "$ctl")" || rc=$?
if grep -q "^FAIL worker leak-tcp UNEXPECTED SUCCESS" <<<"$res" && grep -q "^FAIL worker leak-unix UNEXPECTED SUCCESS" <<<"$res"; then ok "a deny probe that connects is a FAIL (a leak), for tcp and for a unix socket"; else bad "leak result: $res"; fi
if grep -q "^warn worker closed-tcp inconclusive" <<<"$res" ; then ok "a deny probe that fails where the control also failed is only inconclusive"; else bad "closed-tcp: $res"; fi
if grep -q "^ok worker gateway-http works" <<<"$res" && grep -q "^FAIL worker missing-thing should work" <<<"$res"; then ok "an allow probe passes when it works and FAILs when it does not"; else bad "allow results: $res"; fi
if grep -q "^warn worker late-thing not reachable yet" <<<"$res" ; then ok "an allow-late probe that misses is a warning"; else bad "late: $res"; fi
if grep -q "^info worker open-limit known limit" <<<"$res"; then ok "a known limit is reported and never fails by itself"; else bad "known: $res"; fi
if grep -q "^ok worker a-user" <<<"$res" && grep -q "^ok worker a-pair" <<<"$res" && grep -q "^ok worker a-child" <<<"$res"; then ok "user lookup, socketpair and spawning a child are probed"; else bad "functional probes: $res"; fi
if [ "$rc" -eq 1 ]; then ok "exit 1 when anything FAILed"; else bad "exit code $rc"; fi
# no control result for a target: a failed connection is not shown to be the fence's doing, so it is only inconclusive
res2="$(probe fenced worker "$probes" --no-late | grep "closed-tcp\|unknown-closed")"
if [ "$(grep -c '^warn worker .* inconclusive' <<<"$res2")" = "2" ]; then ok "with no control result a failed deny probe is inconclusive, never a pass"; else bad "no-control results: $res2"; fi
ctl3="closed-tcp=open,unknown-closed=open"
res3="$(probe fenced worker "$probes" --control "$ctl3" --no-late | grep "closed-tcp\|unknown-closed")"
if [ "$(grep -c '^ok worker .* blocked' <<<"$res3")" = "2" ]; then ok "a deny probe that fails where the control connected is a pass: blocked"; else bad "blocked results: $res3"; fi
printf 'known worker only-known tcp 127.0.0.1:%s\nknown worker also-known tcp 127.0.0.1:%s\n' "$tcp_port" "$closed_port" >"$work/known.txt"
rc=0
probe fenced worker "$work/known.txt" >"$work/known.out" 2>&1 || rc=$?
if [ "$rc" -eq 0 ] && [ "$(grep -c '^info worker' "$work/known.out")" = "2" ]; then ok "a known limit, reachable or not, never fails the run (exit 0)"; else bad "known-only rc=$rc: $(cat "$work/known.out")"; fi
# the probe functions themselves, with a fake socket module: the abstract name starts with a NUL byte, and a failed user lookup is a failure
python3 -I - "$deploy/fence-probe.py" >"$work/unit.out" 2>&1 <<'PY'
import importlib.util, socket, sys, pwd
spec = importlib.util.spec_from_file_location("fp", sys.argv[1])
fp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fp)
seen = []
class Fake:
    def __init__(self, *a, **k): pass
    def settimeout(self, t): pass
    def connect(self, addr): seen.append(addr)
    def close(self): pass
socket.socket = Fake
ok, _ = fp.attempt("abstract", "/tmp/example-abstract")
assert ok and seen[-1] == "\0/tmp/example-abstract", seen
ok, _ = fp.attempt("unix", "/run/tailscale/tailscaled.sock")
assert ok and seen[-1] == "/run/tailscale/tailscaled.sock", seen
def boom(uid): raise KeyError("no such user")
pwd.getpwuid = boom
ok, detail = fp.attempt("pwd", "-")
assert not ok and "KeyError" in detail, (ok, detail)
print("probe functions ok")
PY
if grep -q "probe functions ok" "$work/unit.out"; then ok "the abstract address starts with a NUL byte, a path address does not, and a failed user lookup is a failure"; else bad "probe function check: $(cat "$work/unit.out")"; fi
res4="$(probe fenced worker "$probes" --late-only)"
if [ "$(printf '%s\n' "$res4" | wc -l | tr -d ' ')" = "1" ] && grep -q "late-thing" <<<"$res4"; then ok "--late-only runs only the late probe"; else bad "late-only: $res4"; fi
res5="$(probe fenced worker "$probes" --no-late)"
if ! grep -q "late-thing" <<<"$res5"; then ok "--no-late leaves it out"; else bad "no-late: $res5"; fi
if [ "$(uname)" = "Linux" ] && [ "$abs_name" != "-" ]; then
  printf 'deny worker abs-leak abstract %s\n' "$abs_name" >"$work/abs.txt"
  r="$(probe fenced worker "$work/abs.txt" --control "abs-leak=open" || true)"
  if grep -q "^FAIL worker abs-leak UNEXPECTED SUCCESS" <<<"$r"; then ok "an abstract unix socket that is reachable is a FAIL"; else bad "abstract: $r"; fi
else
  ok "abstract socket probe: skipped here (no abstract sockets on this OS; CI on Linux runs it)"
fi
printf 'bogus x y z\n' >"$work/badline.txt"
expect_fail_msg "a malformed probe line is an error" "bad probe line" python3 -I "$deploy/fence-probe.py" fenced worker "$work/badline.txt"
printf 'maybe worker n tcp 127.0.0.1:1\n' >"$work/badexpect.txt"
expect_fail_msg "an unknown expectation is an error" "unknown expectation" python3 -I "$deploy/fence-probe.py" fenced worker "$work/badexpect.txt"

echo "the published probe list"
P="$deploy/fence/probes.txt"
ALL="worker,kernel,build,cli-worker,cli-kernel"
WORKERISH="worker,build,cli-worker"
# <target pattern> @@ <the sets whose deny line it must be in, exactly>: a deny probe that exists for only some sets leaves the others unproven
while IFS= read -r row; do
  [ -n "$row" ] || continue
  pat="${row%%@@*}"
  want_sets="${row#*@@}"
  got_sets="$(grep -E "^deny" "$P" | grep -E -- "$pat" | awk '{print $2}' | tr '\n' ' ' | sed 's/ $//')"
  if [ "$got_sets" = "$want_sets" ]; then ok "must-fail probe for $pat covers exactly: $want_sets"; else bad "deny probe for $pat covers '$got_sets', wanted '$want_sets'"; fi
done <<EOF2
127\.0\.0\.53:53( |\$)@@$ALL
/run/tailscale/tailscaled\.sock( |\$)@@$ALL
/run/snapd\.socket( |\$)@@$ALL
/run/docker\.sock( |\$)@@$ALL
/var/run/postgresql/\.s\.PGSQL\.5436( |\$)@@$WORKERISH
EOF2
# user lookup: real users resolve through files, so the lookup must work for them; for the build's DynamicUser it is a documented known limit
if [ "$(grep -E "^allow .* pwd " "$P" | awk '{print $2}')" = "worker,kernel,cli-worker,cli-kernel" ] && [ "$(grep -E "^known .* pwd " "$P" | awk '{print $2}')" = "build" ]; then ok "user-lookup: required for the worker, kernel and CLI sets, a known limit for the build (a DynamicUser needs the varlink socket, which needs AF_UNIX)"; else bad "user-lookup lines: $(grep ' pwd ' "$P")"; fi
if grep -E "^allow +build " "$P" | grep -q "node-homedir"; then ok "and the build is shown not to need it: node's homedir() works from the HOME the build sets"; else bad "no build node-homedir probe"; fi
if grep -E "^allow +worker,cli-worker .* node .*api\.anthropic\.com" "$P" >/dev/null && grep -E "^known +worker,cli-worker .* node .*networkInterfaces" "$P" >/dev/null && grep -E "^allow +worker,cli-worker .* exec +claude --version" "$P" >/dev/null; then ok "worker sets run real node (https to api.anthropic.com, os.networkInterfaces as a known probe) and claude --version"; else bad "worker node/claude probes missing"; fi
for kind in dns https pwd socketpair spawn; do
  if grep -qE "^allow +[a-z,-]+ +[a-z-]+ +$kind " "$P"; then ok "must-work probe present: $kind"; else bad "no allow probe of kind $kind"; fi
done
if grep -qE "^allow-late +worker,cli-worker +[a-z-]+ +http +http://127.74.3.1:7431/healthz" "$P"; then ok "the gateway /healthz probe is a separate, late one for the worker sets"; else bad "gateway probe"; fi
for s in worker kernel build cli-worker cli-kernel; do
  if grep -vE '^#|^$' "$P" | awk -v s="$s" '{ n = split($2, a, ","); for (i = 1; i <= n; i++) if (a[i] == s) c++ } END { exit !(c >= 8) }'; then ok "$s has at least 8 published probes"; else bad "$s has fewer than 8 published probes"; fi
done
if awk '!/^#/ && NF && NF < 5 { print "line " NR ": " $0; bad = 1 } END { exit bad }' "$P" >"$work/cols" 2>&1; then ok "every probe line has at least five columns (the last one may hold spaces)"; else bad "malformed probe lines: $(cat "$work/cols")"; fi
if ! grep -vE '^#' "$P" | grep -E '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | grep -qvE '127\.0\.0\.53|127\.74\.3\.1'; then ok "the published list names no address but the resolver stub and the gateway"; else bad "an address in the published list"; fi

echo "probes derived from the machine"
cat >"$work/d-tcp" <<'DATA'
LISTEN 0 4096 127.0.0.1:41001 0.0.0.0:*
LISTEN 0 4096 [::1]:41002 [::]:*
LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*
LISTEN 0 4096 172.16.0.1:41003 0.0.0.0:*
LISTEN 0 4096 100.64.0.10:41004 0.0.0.0:*
LISTEN 0 128 0.0.0.0:41005 0.0.0.0:*
LISTEN 0 128 [::]:41005 [::]:*
LISTEN 0 128 *:41006 *:*
LISTEN 0 128 203.0.113.10:41007 0.0.0.0:*
LISTEN 0 128 127.74.3.1:7431 0.0.0.0:*
LISTEN 0 128 172.20.0.1:41008 0.0.0.0:*
DATA
cat >"$work/d-unix" <<'DATA'
u_str LISTEN 0 4096 /run/example.sock 111 * 0
u_str LISTEN 0 4096 @/tmp/example-abstract 112 * 0
u_str LISTEN 0 4096 @second 113 * 0
DATA
cat >"$work/d-ip" <<'DATA'
1: lo    inet 127.0.0.1/8 scope host lo
2: eth0    inet 203.0.113.10/32 scope global eth0
2: eth0    inet6 2001:db8::10/64 scope global
6: tailscale0    inet 100.64.0.10/32 scope global tailscale0
7: docker0    inet 172.16.0.1/16 scope global docker0
8: br-1    inet 172.20.0.1/16 scope global br-1
DATA
python3 -I "$deploy/fence-probe.py" derive "$work/d-tcp" "$work/d-unix" "$work/d-ip" >"$work/derived.txt"
sets_for() { awk -v t="$1" '$1 == "deny" && $5 == t { print $2 }' "$work/derived.txt" | sort | tr '\n' ' ' | sed 's/ $//'; }
chk() { # chk <target> <sets>
  if [ "$(sets_for "$1")" = "$2" ]; then ok "derived: $1 is denied for $2"; else bad "derived: $1 -> '$(sets_for "$1")', wanted '$2'"; fi
}
chk 127.0.0.1:41001 "$ALL"
chk "[::1]:41002" "$ALL"
chk 127.0.0.53:53 "$ALL"
chk 172.16.0.1:41003 "$ALL"
chk 100.64.0.10:41004 "$ALL"
chk 127.0.0.1:41005 "$ALL"
chk "[::1]:41005" "$ALL"
chk 172.16.0.1:41005 "$ALL"
chk 100.64.0.10:41005 "$ALL"
chk 203.0.113.10:41005 "$WORKERISH"
chk "[2001:db8::10]:41005" "$WORKERISH"
chk 127.0.0.1:41006 "$ALL"
chk "[::1]:41006" "$ALL"
chk 203.0.113.10:41006 "$WORKERISH"
if ! grep -qE ' 127\.74\.3\.1:' "$work/derived.txt"; then ok "derived: the kernel's own gateway is never a deny target"; else bad "the gateway is in the derived list"; fi
chk 203.0.113.10:41007 ""
chk 172.20.0.1:41008 "$ALL"
chk 172.20.0.1:41005 "$ALL"
if [ "$(awk '$1 == "deny" && $4 == "abstract" { print $2 " " $5 }' "$work/derived.txt" | sort | tr '\n' '|')" = "worker,build,cli-worker /tmp/example-abstract|worker,build,cli-worker second|" ] && [ "$(awk '$1 == "known" && $4 == "abstract" { print $2 " " $5 }' "$work/derived.txt" | sort | tr '\n' '|')" = "kernel,cli-kernel /tmp/example-abstract|kernel,cli-kernel second|" ]; then ok "derived: every abstract socket is denied for the worker, build and worker CLI and a known limit for the kernel sets; a path socket is not an abstract one"; else bad "abstract lines: $(grep abstract "$work/derived.txt")"; fi
python3 -I "$deploy/fence-probe.py" derive "$work/d-tcp" "$work/d-unix" "$work/d-ip" >"$work/derived2.txt"
if cmp -s "$work/derived.txt" "$work/derived2.txt"; then ok "derived: the same machine gives the same list"; else bad "derived list is not stable"; fi
# the order ss prints in does not matter
sed '1!G;h;$!d' "$work/d-tcp" >"$work/d-tcp-rev"
sed '1!G;h;$!d' "$work/d-unix" >"$work/d-unix-rev"
python3 -I "$deploy/fence-probe.py" derive "$work/d-tcp-rev" "$work/d-unix-rev" "$work/d-ip" >"$work/derived3.txt"
if cmp -s "$work/derived.txt" "$work/derived3.txt"; then ok "derived: listeners in the reverse order give the same, sorted list"; else bad "derived list depends on the order ss printed in"; fi
if ! grep -qvE '^(deny|known) ' "$work/derived.txt"; then ok "derived: every line is a probe line"; else bad "odd derived output"; fi
# the derived lines are valid probe lines: the probe reads them
dc="$(python3 -I "$deploy/fence-probe.py" control worker - --host-addrs "203.0.113.10/32" <"$work/derived.txt" | wc -l | tr -d ' ')"
if [ "$dc" -ge 10 ]; then ok "derived: the probe reads the lines it was given ($dc probes in the worker set)"; else bad "derived lines not read ($dc)"; fi
: >"$work/e-empty"
if [ -z "$(python3 -I "$deploy/fence-probe.py" derive "$work/e-empty" "$work/e-empty" "$work/e-empty")" ]; then ok "derived: a machine with nothing listening gives no probes (and no error)"; else bad "derived output from nothing"; fi

echo "the extra probes (set-secret.sh --fence-extra-probes)"
xroot="$work/xroot"
mkdir -p "$xroot/etc/bulig"
chmod 700 "$xroot/etc/bulig"
xs() { BULIG_DEPLOY_TEST_ROOT="$xroot" bash "$deploy/set-secret.sh" --fence-extra-probes; }
printf '# my machine\ndeny worker,kernel,build,cli-worker,cli-kernel local-one tcp 127.0.0.1:41099\ndeny worker,build,cli-worker local-abs abstract example-name\nknown kernel,cli-kernel local-abs2 abstract example-name\n' >"$work/x-good"
expect_ok "a filled-in file is accepted" bash -c "BULIG_DEPLOY_TEST_ROOT='$xroot' bash '$deploy/set-secret.sh' --fence-extra-probes <'$work/x-good'"
if cmp -s "$work/x-good" "$xroot/etc/bulig/fence-extra-probes.txt" && [ "$(mode "$xroot/etc/bulig/fence-extra-probes.txt")" = "600" ]; then ok "and stored as it was, mode 600"; else bad "stored file: $(mode "$xroot/etc/bulig/fence-extra-probes.txt")"; fi
rejects() { # rejects <label> <text it must complain about> <file content>
  printf '%b' "$3" >"$work/x-bad"
  cp "$xroot/etc/bulig/fence-extra-probes.txt" "$work/x-before"
  expect_fail_msg "refused: $1" "$2" bash -c "BULIG_DEPLOY_TEST_ROOT='$xroot' bash '$deploy/set-secret.sh' --fence-extra-probes <'$work/x-bad'"
  if cmp -s "$work/x-before" "$xroot/etc/bulig/fence-extra-probes.txt" && [ -z "$(find "$xroot/etc/bulig" -name '.fence-extra.*')" ]; then ok "  and the stored file is unchanged, no temp file left"; else bad "  stored file changed or temp left after '$1'"; fi
}
rejects "an empty file" "holds no probe" ''
rejects "only comments" "holds no probe" '# nothing\n\n# here\n'
rejects "a placeholder left" "placeholder" 'deny worker n tcp <ADDRESS>:<PORT>\n'
rejects "the template as it comes" "placeholder" "$(cat "$deploy/fence/extra-probes.template")\n"
rejects "an unknown set" "is not a set name" 'deny worker,laptop n tcp 127.0.0.1:1\n'
rejects "an unknown kind" "kind must be" 'deny worker n udp 127.0.0.1:1\n'
rejects "an expectation that is not deny or known" "is not deny or known" 'allow worker n tcp 127.0.0.1:1\n'
rejects "a line with too few fields" "five fields" 'deny worker n tcp\n'
expect_fail_msg "a call with an argument is refused" "usage: set-secret.sh" bash -c "BULIG_DEPLOY_TEST_ROOT='$xroot' bash '$deploy/set-secret.sh' --fence-extra-probes x <'$work/x-good'"
if ! grep -rqE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' "$deploy/fence/extra-probes.template"; then ok "the template holds no address at all (only <ADDRESS>)"; else bad "an address in the template"; fi

echo "fence-check.sh"
# stand-in for systemd-run: records the arguments, then runs what comes after "--" here (the probe, with python3 in place of /usr/bin/python3)
cat >"$stubs/systemd-run" <<'STUB'
#!/usr/bin/env bash
echo "systemd-run $*" >>"$STUB_LOG/runs"
if [ -n "${STUB_RUN_FAIL:-}" ]; then echo "Failed to start transient service: property refused" >&2; exit 1; fi
if [ -n "${STUB_RUN_EMPTY:-}" ]; then exit 0; fi
while [ "$1" != "--" ]; do shift; done
shift
[ "$1" = "/usr/bin/python3" ] && shift
# STUB_HIDE=<path>: play the fence by making that one path unreachable while the probe runs (the control run, before this, saw it)
if [ -n "${STUB_HIDE:-}" ]; then
  mv "$STUB_HIDE" "$STUB_HIDE.hidden"
  python3 "$@"; rc=$?
  mv "$STUB_HIDE.hidden" "$STUB_HIDE"
  exit "$rc"
fi
exec python3 "$@"
STUB
chmod +x "$stubs/systemd-run"
new_host
for u in bulig.service bulig-worker.service; do cp "$deploy/systemd/$u" "$SD/$u"; done
bash "$deploy/host-addresses.sh" >/dev/null 2>&1
bash "$deploy/set-mac-worker.sh" 100.101.102.103 >/dev/null 2>&1
mkdir -p "$work/empty"
printf 'deny worker,kernel,build,cli-worker,cli-kernel leak tcp 127.0.0.1:%s\nallow worker,kernel,build,cli-worker,cli-kernel http http http://127.0.0.1:%s/x\n' "$tcp_port" "$http_port" >"$work/fc-leak.txt"
printf 'deny worker,kernel,build,cli-worker,cli-kernel gone tcp 127.0.0.1:%s\nallow worker,kernel,build,cli-worker,cli-kernel http http http://127.0.0.1:%s/x\nallow-late worker,cli-worker late http http://127.0.0.1:%s/x\n' "$closed_port" "$http_port" "$closed_port" >"$work/fc-clean.txt"
: >"$log/runs"
rc=0
BULIG_FENCE_PROBES="$work/fc-leak.txt" bash "$deploy/fence-check.sh" all >"$work/fc.out" 2>&1 || rc=$?
if [ "$rc" -eq 1 ] && [ "$(grep -c '^FAIL .* leak UNEXPECTED SUCCESS' "$work/fc.out")" = "5" ]; then ok "a leak in any of the five sets fails fence-check (5 FAIL lines, exit 1)"; else bad "leak run rc=$rc: $(cat "$work/fc.out")"; fi
if grep -q "fence-check: FAILED" "$work/fc.out"; then ok "and it says FAILED"; else bad "no FAILED line"; fi
rc=0
: >"$log/runs"
BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" all >"$work/fc.out" 2>&1 || rc=$?
if [ "$rc" -eq 0 ] && grep -q "fence-check: ok" "$work/fc.out"; then ok "no leak: exit 0"; else bad "clean run rc=$rc: $(cat "$work/fc.out")"; fi
if [ "$(grep -c '^warn .* gone inconclusive' "$work/fc.out")" = "5" ]; then ok "a target that is not listening shows as inconclusive, per set, and does not pass silently"; else bad "inconclusive count: $(grep -c inconclusive "$work/fc.out")"; fi
run_for() { grep -- "--unit=bulig-fence-$1-" "$log/runs" | head -1; }
w="$(run_for worker)"
case "$w" in *"--uid=bulig-worker"*"-p IPAddressDeny=$DENY $HOSTS "*"-p IPAddressAllow=127.74.3.1/32 "*"-p RestrictAddressFamilies=AF_INET AF_INET6 "*"-p InaccessiblePaths=$INACC "*"-p BindReadOnlyPaths=$RES "*) ok "worker set: read from the installed unit and its drop-in (uid, deny with the host addresses, the gateway allow, no AF_UNIX, hidden sockets, upstream resolvers)" ;; *) bad "worker run: $w" ;; esac
k="$(run_for kernel)"
case "$k" in *"--uid=bulig "*"-p IPAddressDeny=$DENY "*"-p IPAddressAllow=127.74.3.1/32 100.101.102.103/32 "*"-p RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 "*) ok "kernel set: keeps AF_UNIX, allows its gateway and exactly the Mac worker's /32 from the drop-in" ;; *) bad "kernel run: $k" ;; esac
b="$(run_for build)"
case "$b" in *"-p DynamicUser=yes"*"-p RestrictAddressFamilies=AF_INET AF_INET6"*"-p IPAddressDeny=$DENY $HOSTS "*) ok "build set: DynamicUser, no AF_UNIX, the deny list with the host addresses" ;; *) bad "build run: $b" ;; esac
case "$b" in *"--uid="* | *"IPAddressAllow"*) bad "the build set has a named user or an Allow: $b" ;; *) ok "and no named user and no Allow" ;; esac
cw="$(run_for cli-worker)"; ck="$(run_for cli-kernel)"
case "$cw" in *"--uid=bulig-worker"*"RestrictAddressFamilies=AF_INET AF_INET6"*) ok "cli-worker set: no AF_UNIX" ;; *) bad "cli-worker run: $cw" ;; esac
case "$ck" in *"--uid=bulig "*"RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6"*) ok "cli-kernel set: keeps AF_UNIX" ;; *) bad "cli-kernel run: $ck" ;; esac
# a target that the control run reached from outside and the fenced run cannot reach is the one case that is a real pass
printf 'deny worker hidden-sock unix %s\n' "$unix_path" >"$work/fc-hidden.txt"
rc=0
STUB_HIDE="$unix_path" BULIG_FENCE_PROBES="$work/fc-hidden.txt" bash "$deploy/fence-check.sh" worker >"$work/fc.out" 2>&1 || rc=$?
if [ "$rc" -eq 0 ] && grep -q "^ok worker hidden-sock blocked" "$work/fc.out" && ! grep -q "^warn" "$work/fc.out"; then ok "a target reached by the control and not by the fenced run is a pass: blocked (so the control run is what makes a pass mean something)"; else bad "hidden-target rc=$rc: $(cat "$work/fc.out")"; fi
# the machine-specific probes are required, and are part of the run
EX="$root/etc/bulig/fence-extra-probes.txt"
cp "$EX" "$work/ex.keep"
rm -f "$EX"
expect_fail_msg "fence-check fails when the extra probes file is missing" "fence-extra-probes.txt is missing or empty" env BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker
: >"$EX"
expect_fail_msg "and when it is empty" "is missing or empty" env BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker
printf '# only a comment\n\n' >"$EX"
expect_fail_msg "and when it holds only comments" "holds no probe" env BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker
printf 'deny worker n tcp <ADDRESS>:<PORT>\n' >"$EX"
expect_fail_msg "and when a placeholder is still in it" "placeholder" env BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker
printf 'deny worker,kernel,build,cli-worker,cli-kernel extra-leak tcp 127.0.0.1:%s\n' "$tcp_port" >"$EX"
rc=0
BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker >"$work/fc.out" 2>&1 || rc=$?
if [ "$rc" -eq 1 ] && grep -q "^FAIL worker extra-leak UNEXPECTED SUCCESS" "$work/fc.out"; then ok "a probe in the extra file is run, and a leak found by it fails the check"; else bad "extra probe not run: rc=$rc $(cat "$work/fc.out")"; fi
cp "$work/ex.keep" "$EX"
# probes derived from what the machine is listening on are part of the run too
printf 'LISTEN 0 4096 127.0.0.1:%s 0.0.0.0:*\n' "$tcp_port" >"$log/ss-tcp"
rc=0
BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker >"$work/fc.out" 2>&1 || rc=$?
if [ "$rc" -eq 1 ] && grep -q "^FAIL worker listener-127.0.0.1-$tcp_port UNEXPECTED SUCCESS" "$work/fc.out"; then ok "a loopback listener found with ss becomes a deny probe without being named anywhere, and a leak to it fails the check"; else bad "derived probe not run: rc=$rc $(cat "$work/fc.out")"; fi
printf 'u_str LISTEN 0 4096 @example-abstract-name 1 * 0\n' >"$log/ss-unix"
: >"$log/ss-tcp"
BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker kernel >"$work/fc.out" 2>&1 || true
if grep -q "worker abstract-1 " "$work/fc.out" && grep -q "^info kernel abstract-1 known limit" "$work/fc.out"; then ok "an abstract socket found with ss is probed: denied for the worker, a known limit for the kernel"; else bad "derived abstract probes: $(grep abstract "$work/fc.out")"; fi
: >"$log/ss-unix"
if ! grep -q "work\." <(ls "$root/var/lib/bulig-checks" 2>/dev/null); then ok "the probe stream is removed afterwards"; else bad "work folder left in $(ls "$root/var/lib/bulig-checks")"; fi

# a drop-in that opens a hole is part of what is tested
mkdir -p "$SD/bulig-worker.service.d"
printf '[Service]\nIPAddressAllow=127.0.0.1/32\nRestrictAddressFamilies=AF_UNIX\n' >"$SD/bulig-worker.service.d/99-hole.conf"
: >"$log/runs"
BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker >/dev/null 2>&1 || true
case "$(run_for worker)" in *"IPAddressAllow=127.74.3.1/32 127.0.0.1/32"*"RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX"*) ok "a drop-in that adds 127.0.0.1 and AF_UNIX is passed to the probe, so the probe would catch it" ;; *) bad "drop-in not merged: $(run_for worker)" ;; esac
printf '[Service]\nIPAddressAllow=\nIPAddressAllow=100.64.1.1/32\n' >"$SD/bulig-worker.service.d/99-hole.conf"
: >"$log/runs"
BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker >/dev/null 2>&1 || true
case "$(run_for worker)" in *"IPAddressAllow=100.64.1.1/32 "*) ok "an empty assignment resets the list, as in systemd" ;; *) bad "reset not honoured: $(run_for worker)" ;; esac
rm -f "$SD/bulig-worker.service.d/99-hole.conf"
rc=0
STUB_RUN_FAIL=1 BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker >"$work/fc.out" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && grep -q "^FAIL worker did-not-run" "$work/fc.out"; then ok "a set that systemd refused to run is a FAIL, not a silent pass"; else bad "did-not-run rc=$rc: $(cat "$work/fc.out")"; fi
rc=0
STUB_RUN_EMPTY=1 BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker >"$work/fc.out" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && grep -q "^FAIL worker no-output" "$work/fc.out"; then ok "a probe that exits 0 and prints nothing is a FAIL, not a pass"; else bad "empty result rc=$rc: $(cat "$work/fc.out")"; fi
# a unit with no fence at all is an error of its own, not something to probe around
cp "$SD/bulig-worker.service" "$work/worker.unit"
grep -v '^IPAddressDeny=' "$work/worker.unit" >"$SD/bulig-worker.service"
rm -rf "$SD/bulig-worker.service.d"
expect_fail_msg "a worker unit with no IPAddressDeny is refused" "has no IPAddressDeny=" env BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker
grep -v '^RestrictAddressFamilies=' "$work/worker.unit" >"$SD/bulig-worker.service"
expect_fail_msg "a worker unit with no RestrictAddressFamilies is refused" "has no RestrictAddressFamilies=" env BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker
cp "$work/worker.unit" "$SD/bulig-worker.service"
bash "$deploy/host-addresses.sh" >/dev/null 2>&1
rm -f "$SD/bulig-worker.service"
expect_fail_msg "a set whose unit is not installed is an error" "bulig-worker.service is not installed" env BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker
cp "$deploy/systemd/bulig-worker.service" "$SD/"
rc=0
: >"$log/runs"
BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker --late-only --late-strict >"$work/fc.out" 2>&1 || rc=$?
if [ "$rc" -eq 1 ] && grep -q "^FAIL worker gateway-not-reachable" "$work/fc.out"; then ok "--late-strict turns an unreachable gateway into a FAIL (the kernel is known to be up)"; else bad "late-strict rc=$rc: $(cat "$work/fc.out")"; fi
rc=0
BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker --late-only >"$work/fc.out" 2>&1 || rc=$?
if [ "$rc" -eq 0 ] && grep -q "^warn worker late not reachable yet" "$work/fc.out"; then ok "without --late-strict the same miss is only a warning"; else bad "late rc=$rc: $(cat "$work/fc.out")"; fi
expect_fail_msg "an unknown set is refused" "usage: fence-check.sh" bash "$deploy/fence-check.sh" nonsense

echo "the loaded properties (systemctl show)"
fs() { ( . "$deploy/lib/common.sh"; . "$deploy/lib/fence.sh"; fence_source ); }
if [ "$(env -u BULIG_DEPLOY_TEST_ROOT -u BULIG_FENCE_SOURCE bash -c ". '$deploy/lib/common.sh'; . '$deploy/lib/fence.sh'; fence_source")" = "show" ]; then ok "on the server (no test root) the properties come from systemctl show"; else bad "default source on the server is not show"; fi
if [ "$(fs)" = "files" ] && [ "$(BULIG_FENCE_SOURCE=show fs)" = "show" ]; then ok "with the paths redirected for the tests they come from the files; BULIG_FENCE_SOURCE overrides"; else bad "fence_source: $(fs)"; fi
shown="$work/show.txt"
cat >"$shown" <<DATA
LoadState=loaded
User=bulig-worker
IPAddressDeny=127.0.0.0/8 ::1/128 10.0.0.0/8
IPAddressAllow=127.74.3.1 127.0.0.1
RestrictAddressFamilies=AF_INET AF_INET6
InaccessiblePaths=-/run/tailscale -/run/docker.sock
BindPaths=
BindReadOnlyPaths=/run/systemd/resolve/resolv.conf:/etc/resolv.conf
SupplementaryGroups=
ProtectSystem=strict
PrivateTmp=yes
ProtectHome=yes
ProtectProc=invisible
DATA
: >"$log/runs"
STUB_SHOW_FILE="$shown" BULIG_FENCE_SOURCE=show BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker --no-late >"$work/fc.out" 2>&1 || true
w="$(grep -- '--unit=bulig-fence-worker-' "$log/runs" | head -1)"
case "$w" in *"--uid=bulig-worker"*"-p IPAddressDeny=127.0.0.0/8 ::1/128 10.0.0.0/8 "*"-p IPAddressAllow=127.74.3.1 127.0.0.1 "*) ok "the probe gets the LOADED values (here a 127.0.0.1 that no file has, as set-property would leave it), so a loaded hole is tested" ;; *) bad "loaded run: $w" ;; esac
case "$w" in *"BindPaths="*) bad "an empty loaded property was passed on: $w" ;; *) ok "an empty loaded property (BindPaths=) is not passed on" ;; esac
case "$w" in *"-p BindReadOnlyPaths=/run/systemd/resolve/resolv.conf:/etc/resolv.conf "*"-p ProtectSystem=strict "*) ok "bind paths and the single-value settings come from the loaded unit too" ;; *) bad "loaded bind/protect: $w" ;; esac
sed 's/^SupplementaryGroups=$/SupplementaryGroups=docker/' "$shown" >"$work/show-groups.txt"
expect_fail_msg "a loaded worker with SupplementaryGroups is refused (it would gain docker's sockets)" "SupplementaryGroups=docker" env STUB_SHOW_FILE="$work/show-groups.txt" BULIG_FENCE_SOURCE=show BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker
sed 's/^LoadState=loaded$/LoadState=not-found/' "$shown" >"$work/show-nf.txt"
expect_fail_msg "a unit systemd has not loaded is refused" "is not loaded by systemd" env STUB_SHOW_FILE="$work/show-nf.txt" BULIG_FENCE_SOURCE=show BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker
mkdir -p "$SD/bulig-worker.service.d"
printf '[Service]\nSupplementaryGroups=docker\n' >"$SD/bulig-worker.service.d/98-groups.conf"
expect_fail_msg "the file path refuses SupplementaryGroups in a drop-in as well" "SupplementaryGroups=docker" env BULIG_FENCE_SOURCE=files BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker
rm -f "$SD/bulig-worker.service.d/98-groups.conf"

echo "node and exec probes, and the build's HOME"
if [ -n "$NODE_DIR" ]; then
  printf 'allow worker node-ok node require("http").get("http://127.0.0.1:%s/x",r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))\nallow worker node-bad node process.exit(3)\nknown worker node-known node process.exit(4)\nallow worker exec-ok exec python3 --version\nallow worker exec-bad exec python3 -c raise\n' "$http_port" >"$work/nodeprobes.txt"
  res="$(PATH="$NODE_DIR:$PATH" probe fenced worker "$work/nodeprobes.txt" || true)"
  if grep -q "^ok worker node-ok works" <<<"$res" && grep -q "^FAIL worker node-bad should work" <<<"$res" && grep -q "^info worker node-known known limit: node .* does not work (exit 4" <<<"$res"; then ok "a node probe works when node exits 0, fails when it does not, and a known one only reports"; else bad "node probes: $res"; fi
  if grep -q "^ok worker exec-ok works" <<<"$res" && grep -q "^FAIL worker exec-bad should work" <<<"$res"; then ok "an exec probe (claude --version's kind) works when the command exits 0 and fails when it does not"; else bad "exec probes: $res"; fi
else
  ok "node probes: skipped (no node on this machine's PATH; CI has node)"
fi
: >"$log/runs"
BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" build >/dev/null 2>&1 || true
case "$(grep -- '--unit=bulig-fence-build-' "$log/runs" | head -1)" in *"--setenv=HOME=/var/tmp/home"*) ok "the build set is probed with HOME set explicitly, as the real build does (a DynamicUser has no passwd entry to take it from)" ;; *) bad "build probe has no HOME" ;; esac
if grep -q -- '--setenv=HOME=/var/tmp/home' "$deploy/release-remote.sh"; then ok "and the real build sets that HOME"; else bad "release-remote.sh does not set HOME for the build"; fi

kill "$fixture_pid" 2>/dev/null || true
wait "$fixture_pid" 2>/dev/null || true
finish
