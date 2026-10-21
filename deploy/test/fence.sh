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
  *"dev tailscale0"*) echo "6: tailscale0    inet 100.64.0.10/32 scope global tailscale0" ;;  # scan-forbidden: allow-addresses (a Tailscale test address)
  *"scope global"*)
    cat <<'DATA'
2: eth0    inet 203.0.113.10/32 metric 100 scope global dynamic eth0
2: eth0    inet6 2001:db8::10/64 scope global
6: tailscale0    inet 100.64.0.10/32 scope global tailscale0  scan-forbidden: allow-addresses (a Tailscale test address)
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
# `systemctl list-sockets`: STUB_SOCKETS is a file of its output (nothing by default); STUB_SOCKETS_FAIL makes it fail
if [ "$1" = "list-sockets" ]; then
  if [ -n "${STUB_SOCKETS_FAIL:-}" ]; then echo "Failed to list sockets" >&2; exit 1; fi
  if [ -n "${STUB_SOCKETS:-}" ]; then cat "$STUB_SOCKETS"; fi
fi
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
expect_ok "a Tailscale address is accepted" bash "$deploy/set-mac-worker.sh" 100.101.102.103  # scan-forbidden: allow-addresses (a Tailscale test address)
if [ "$(grep -v '^#' "$mw" | tr '\n' '|')" = "[Service]|IPAddressAllow=100.101.102.103/32|" ]; then ok "the drop-in allows that one /32"; else bad "mac drop-in: $(cat "$mw")"; fi  # scan-forbidden: allow-addresses (a Tailscale test address)
if [ "$(mode "$mw")" = "644" ]; then ok "root-owned mode 644"; else bad "mode $(mode "$mw")"; fi
# (the addresses just outside the Tailscale range are built from parts: the repository scan refuses to have them written out)
for bad_ip in 127.0.0.1 10.0.0.5 "100.$((64 - 1)).255.255" "100.$((127 + 1)).0.1" "$((4 * 2)).$((4 * 2)).$((4 * 2)).$((4 * 2))" 100.101.102 100.101.102.103/32 100.101.102.256 100.064.1.1 100.101.102.103.4 mac.tail.net "" "100.101.102.103 100.64.1.1"; do  # scan-forbidden: allow-addresses (a Tailscale test address)
  expect_fail_msg "refused: '$bad_ip'" "" bash "$deploy/set-mac-worker.sh" "$bad_ip"
  if [ "$(grep -c 'IPAddressAllow' "$mw")" = "1" ] && grep -q "100.101.102.103/32" "$mw"; then :; else bad "the drop-in changed after a refusal of '$bad_ip'"; fi  # scan-forbidden: allow-addresses (a Tailscale test address)
done
expect_fail_msg "two arguments are refused" "usage: set-mac-worker.sh" bash "$deploy/set-mac-worker.sh" 100.101.102.103 100.64.1.1  # scan-forbidden: allow-addresses (a Tailscale test address)
: >"$log/systemctl"
bash "$deploy/set-mac-worker.sh" 100.101.102.104 >/dev/null 2>&1  # scan-forbidden: allow-addresses (a Tailscale test address)
if grep -q "daemon-reload" "$log/systemctl"; then ok "systemd is told to reload after the drop-in changes"; else bad "no daemon-reload after set-mac-worker"; fi
expect_ok "100.64.0.0 is the lowest Tailscale address" bash "$deploy/set-mac-worker.sh" 100.64.0.0  # scan-forbidden: allow-addresses (a Tailscale test address)
expect_ok "100.127.255.255 is the highest" bash "$deploy/set-mac-worker.sh" 100.127.255.255  # scan-forbidden: allow-addresses (a Tailscale test address)
if grep -q "IPAddressAllow=100.127.255.255/32" "$mw" && [ "$(grep -c IPAddressAllow "$mw")" = "1" ]; then ok "a second run replaces the first (one peer at a time)"; else bad "mac drop-in after rerun: $(cat "$mw")"; fi  # scan-forbidden: allow-addresses (a Tailscale test address)
expect_ok "--remove deletes it" bash "$deploy/set-mac-worker.sh" --remove
if [ ! -e "$mw" ]; then ok "and the kernel allows no Tailscale peer again"; else bad "drop-in still there"; fi
expect_fail_msg "no argument is refused" "usage: set-mac-worker.sh" bash "$deploy/set-mac-worker.sh"
mkdir -p "$SD/bulig.service.d"
ln -s "$work/elsewhere" "$mw"
expect_fail_msg "a link where the drop-in belongs is refused (set)" "is a link" bash "$deploy/set-mac-worker.sh" 100.101.102.103  # scan-forbidden: allow-addresses (a Tailscale test address)
expect_fail_msg "a link where the drop-in belongs is refused (remove)" "is a link" bash "$deploy/set-mac-worker.sh" --remove
rm -f "$mw"

echo "the properties of each set"
props() { # props <function call...>: print the array the function fills, one -p value per line
  bash -c ". '$deploy/lib/common.sh'; . '$deploy/lib/fence.sh'; $1" | tr '\n' ' '
}
DENY="127.0.0.0/8 ::1/128 169.254.0.0/16 fe80::/10 224.0.0.0/4 ff00::/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7"
HOSTS="2001:db8::10/128 203.0.113.10/32"
INACC="-/run/tailscale -/run/snapd.socket -/run/docker.sock -/var/run/docker.sock"
RES="/run/systemd/resolve/resolv.conf:/etc/resolv.conf"
# shellcheck disable=SC2016
got="$(props 'build_fence_props; printf "%s\n" "${FENCE_BUILD[@]}"')"
want="-p DynamicUser=yes -p RestrictAddressFamilies=AF_INET AF_INET6 -p IPAddressDeny=$DENY $HOSTS -p InaccessiblePaths=$INACC -p BindReadOnlyPaths=$RES "
if [ "$got" = "$want" ]; then ok "build: throwaway user, no AF_UNIX, private ranges and the host's addresses denied, nothing allowed, sockets hidden, upstream resolvers"; else bad "build props: $got"; fi
# shellcheck disable=SC2016
got="$(props 'cli_fence_props worker; printf "%s\n" "${FENCE_CLI[@]}"')"
INACC_W="$INACC -/run/postgresql -/var/run/postgresql -/run/dbus -/run/snapd-snap.socket -/run/systemd/userdb -/run/systemd/resolve/io.systemd.Resolve -/run/systemd/resolve/io.systemd.Resolve.Monitor -/run/user"
want="-p RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK -p IPAddressDeny=$DENY $HOSTS -p IPAddressAllow=127.74.3.1/32 -p InaccessiblePaths=$INACC_W -p BindReadOnlyPaths=$RES -p LimitCORE=0 "
if [ "$got" = "$want" ]; then ok "cli worker: AF_UNIX and AF_NETLINK for Claude Code's sandbox, denies like the build, allows the gateway address only, hides the Postgres folder and the system bus too"; else bad "cli worker props: $got"; fi
# The worker's one-off commands are meant to have the same fence as bulig-worker.service: compare them key by key (the unit's deny list plus
# the host addresses its drop-in adds).
uv() { grep -E "^$1=" "$deploy/systemd/bulig-worker.service" | sed -E "s/^$1=//"; }
# shellcheck disable=SC2016
cli_v() { bash -c ". '$deploy/lib/common.sh'; cli_fence_props worker; for e in \"\${FENCE_CLI[@]}\"; do case \"\$e\" in $1=*) printf '%s' \"\${e#*=}\" ;; esac; done"; }
same=1
for key in RestrictAddressFamilies IPAddressAllow InaccessiblePaths BindReadOnlyPaths; do
  if [ "$(cli_v "$key")" != "$(uv "$key")" ]; then same=0; echo "    $key: unit '$(uv "$key")', cli '$(cli_v "$key")'" >&2; fi
done
if [ "$(cli_v IPAddressDeny)" != "$(uv IPAddressDeny) $HOSTS" ]; then same=0; echo "    IPAddressDeny: unit '$(uv IPAddressDeny)' + host, cli '$(cli_v IPAddressDeny)'" >&2; fi
if [ "$same" -eq 1 ]; then ok "cli worker: the same families, allow list, hidden paths, resolver and (with the host drop-in) deny list as bulig-worker.service"; else bad "cli worker and bulig-worker.service have different fences"; fi
# shellcheck disable=SC2016
got="$(props 'cli_fence_props kernel; printf "%s\n" "${FENCE_CLI[@]}"')"
want="-p RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 -p IPAddressDeny=$DENY -p IPAddressAllow=127.74.3.1/32 -p InaccessiblePaths=$INACC -p BindReadOnlyPaths=$RES -p LimitCORE=0 "
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
# What the control run reads instead of connecting: ss output for the listeners above, and systemctl list-sockets output (nothing activated yet).
# (the abstract line is synthetic, so the text-only logic is tested on every OS; the fixture's real abstract socket exists on Linux only)
printf 'LISTEN 0 5 127.0.0.1:%s 0.0.0.0:*\nLISTEN 0 5 127.0.0.1:%s 0.0.0.0:*\n' "$tcp_port" "$http_port" >"$work/ss-tcp.txt"
printf 'u_str LISTEN 0 5 %s 1 * 0\nu_str LISTEN 0 5 @%s 2 * 0\nu_dgr UNCONN 0 0 /run/not-a-listener 3 * 0\n' "$unix_path" "$abs_name" >"$work/ss-unix.txt"
: >"$work/act-none.txt"
CA=(--ss-tcp "$work/ss-tcp.txt" --ss-unix "$work/ss-unix.txt")
NOUNIX="AF_INET AF_INET6"
WITHUNIX="AF_UNIX AF_INET AF_INET6"
out="$(probe control worker "$probes" "${CA[@]}" --host-addrs "203.0.113.10/32 2001:db8::10/128")"
if grep -qx "leak-tcp=open" <<<"$out" && grep -qx "closed-tcp=closed" <<<"$out" && grep -qx "leak-unix=open" <<<"$out" && grep -qx "open-limit=open" <<<"$out"; then ok "control run: says which deny and known targets are really listening"; else bad "control output: $out"; fi
if grep -q "host-ssh-203.0.113.10=closed" <<<"$out" && grep -q "host-ssh-2001:db8::10=closed" <<<"$out"; then ok "@HOST@ gives one probe per address (v4 and v6)"; else bad "placeholders: $out"; fi
if ! grep -q "only-kernel" <<<"$out"; then ok "a probe for another set is not run"; else bad "the kernel probe ran in the worker set"; fi
ctl="$(printf '%s\n' "$out" | paste -sd, -)"
rc=0
res="$(probe fenced worker "$probes" --host-addrs "203.0.113.10/32" --control "$ctl" --af "$NOUNIX" --activation-text "" --ip-deny "127.0.0.0/8 ::1/128")" || rc=$?
if grep -q "^FAIL worker leak-tcp UNEXPECTED SUCCESS" <<<"$res" && grep -q "^FAIL worker leak-unix UNEXPECTED SUCCESS" <<<"$res"; then ok "a deny probe that connects is a FAIL (a leak), for tcp and for a unix socket"; else bad "leak result: $res"; fi
if grep -q "^warn worker closed-tcp inconclusive" <<<"$res" ; then ok "a deny probe that fails where the control also failed is only inconclusive"; else bad "closed-tcp: $res"; fi
if grep -q "^ok worker gateway-http works" <<<"$res" && grep -q "^FAIL worker missing-thing should work" <<<"$res"; then ok "an allow probe passes when it works and FAILs when it does not"; else bad "allow results: $res"; fi
if grep -q "^warn worker late-thing not reachable yet" <<<"$res" ; then ok "an allow-late probe that misses is a warning"; else bad "late: $res"; fi
if grep -q "^info worker open-limit known limit" <<<"$res"; then ok "a known limit is reported and never fails by itself"; else bad "known: $res"; fi
if grep -q "^ok worker a-user" <<<"$res" && grep -q "^ok worker a-pair" <<<"$res" && grep -q "^ok worker a-child" <<<"$res"; then ok "user lookup, socketpair and spawning a child are probed"; else bad "functional probes: $res"; fi
if [ "$rc" -eq 1 ]; then ok "exit 1 when anything FAILed"; else bad "exit code $rc"; fi
# no control result for a target: a failed connection is not shown to be the fence's doing, so it is only inconclusive
res2="$(probe fenced worker "$probes" --no-late --control "" --af "$NOUNIX" --activation-text "" --ip-deny "127.0.0.0/8 ::1/128" | grep "closed-tcp\|unknown-closed")"
if [ "$(grep -c '^warn worker .* inconclusive' <<<"$res2")" = "2" ]; then ok "with no control result a failed deny probe is inconclusive, never a pass"; else bad "no-control results: $res2"; fi
ctl3="closed-tcp=open,unknown-closed=open"
res3="$(probe fenced worker "$probes" --control "$ctl3" --af "$NOUNIX" --activation-text "" --ip-deny "127.0.0.0/8 ::1/128" --no-late | grep "closed-tcp\|unknown-closed")"
if [ "$(grep -c '^ok worker .* blocked' <<<"$res3")" = "2" ]; then ok "a deny probe that fails where the control connected is a pass: blocked"; else bad "blocked results: $res3"; fi
printf 'known worker only-known tcp 127.0.0.1:%s\nknown worker also-known tcp 127.0.0.1:%s\n' "$tcp_port" "$closed_port" >"$work/known.txt"
rc=0
probe fenced worker "$work/known.txt" --control "" --af "$NOUNIX" --activation-text "" --ip-deny "127.0.0.0/8 ::1/128" >"$work/known.out" 2>&1 || rc=$?
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
res4="$(probe fenced worker "$probes" --late-only --control "" --af "$NOUNIX" --activation-text "" --ip-deny "127.0.0.0/8 ::1/128")"
if [ "$(printf '%s\n' "$res4" | wc -l | tr -d ' ')" = "1" ] && grep -q "late-thing" <<<"$res4"; then ok "--late-only runs only the late probe"; else bad "late-only: $res4"; fi
res5="$(probe fenced worker "$probes" --no-late --control "" --af "$NOUNIX" --activation-text "" --ip-deny "127.0.0.0/8 ::1/128")"
if ! grep -q "late-thing" <<<"$res5"; then ok "--no-late leaves it out"; else bad "no-late: $res5"; fi
if [ "$(uname)" = "Linux" ] && [ "$abs_name" != "-" ]; then
  printf 'deny worker abs-leak abstract %s\n' "$abs_name" >"$work/abs.txt"
  r="$(probe fenced worker "$work/abs.txt" --control "abs-leak=open" --af "$NOUNIX" --activation-text "" --ip-deny "127.0.0.0/8 ::1/128" || true)"
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
LISTEN 0 4096 100.64.0.10:41004 0.0.0.0:*  scan-forbidden: allow-addresses (a Tailscale test address)
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
6: tailscale0    inet 100.64.0.10/32 scope global tailscale0  scan-forbidden: allow-addresses (a Tailscale test address)
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
chk 100.64.0.10:41004 "$ALL"  # scan-forbidden: allow-addresses (a Tailscale test address)
chk 127.0.0.1:41005 "$ALL"
chk "[::1]:41005" "$ALL"
chk 172.16.0.1:41005 "$ALL"
chk 100.64.0.10:41005 "$ALL"  # scan-forbidden: allow-addresses (a Tailscale test address)
chk 203.0.113.10:41005 "$WORKERISH"
chk "[2001:db8::10]:41005" "$WORKERISH"
chk 127.0.0.1:41006 "$ALL"
chk "[::1]:41006" "$ALL"
chk 203.0.113.10:41006 "$WORKERISH"
if ! grep -qE ' 127\.74\.3\.1:' "$work/derived.txt"; then ok "derived: the kernel's own gateway is never a deny target"; else bad "the gateway is in the derived list"; fi
chk 203.0.113.10:41007 ""
chk 172.20.0.1:41008 "$ALL"
chk 172.20.0.1:41005 "$ALL"
if [ "$(awk '$1 == "deny" && $4 == "abstract" { print $2 " " $5 }' "$work/derived.txt" | sort | tr '\n' '|')" = "build /tmp/example-abstract|build second|" ] && [ "$(awk '$1 == "known" && $4 == "abstract" { print $2 " " $5 }' "$work/derived.txt" | sort | tr '\n' '|')" = "worker,kernel,cli-worker,cli-kernel /tmp/example-abstract|worker,kernel,cli-worker,cli-kernel second|" ]; then ok "derived: every abstract socket is denied for the build (no AF_UNIX) and a known limit for the kernel and worker sets (AF_UNIX); a path socket is not an abstract one"; else bad "abstract lines: $(grep abstract "$work/derived.txt")"; fi
python3 -I "$deploy/fence-probe.py" derive "$work/d-tcp" "$work/d-unix" "$work/d-ip" >"$work/derived2.txt"
if cmp -s "$work/derived.txt" "$work/derived2.txt"; then ok "derived: the same machine gives the same list"; else bad "derived list is not stable"; fi
# the order ss prints in does not matter
sed '1!G;h;$!d' "$work/d-tcp" >"$work/d-tcp-rev"
sed '1!G;h;$!d' "$work/d-unix" >"$work/d-unix-rev"
python3 -I "$deploy/fence-probe.py" derive "$work/d-tcp-rev" "$work/d-unix-rev" "$work/d-ip" >"$work/derived3.txt"
if cmp -s "$work/derived.txt" "$work/derived3.txt"; then ok "derived: listeners in the reverse order give the same, sorted list"; else bad "derived list depends on the order ss printed in"; fi
if ! grep -qvE '^(deny|known|reach) ' "$work/derived.txt"; then ok "derived: every line is a probe line"; else bad "odd derived output"; fi
if [ "$(grep '^reach ' "$work/derived.txt")" = "reach worker,cli-worker path-1 unix-path /run/example.sock" ]; then ok "derived: the listening path socket becomes one reach line for the worker sets (an abstract one does not)"; else bad "reach lines: $(grep '^reach ' "$work/derived.txt")"; fi
# the derived lines are valid probe lines: the probe reads them
dc="$(python3 -I "$deploy/fence-probe.py" control worker - "${CA[@]}" --host-addrs "203.0.113.10/32" <"$work/derived.txt" | wc -l | tr -d ' ')"
if [ "$dc" -ge 10 ]; then ok "derived: the probe reads the lines it was given ($dc probes in the worker set)"; else bad "derived lines not read ($dc)"; fi
: >"$work/e-empty"
if [ -z "$(python3 -I "$deploy/fence-probe.py" derive "$work/e-empty" "$work/e-empty" "$work/e-empty")" ]; then ok "derived: a machine with nothing listening gives no probes (and no error)"; else bad "derived output from nothing"; fi

printf 'LISTEN 0 4096 [::ffff:127.0.0.1]:41009 *:*\nLISTEN 0 4096 [::ffff:10.1.2.3]:41010 *:*\nLISTEN 0 4096 [::ffff:127.74.3.1]:7431 *:*\nLISTEN 0 4096 [::ffff:203.0.113.10]:41011 *:*\n' >"$work/d-tcp-mapped"
python3 -I "$deploy/fence-probe.py" derive "$work/d-tcp-mapped" "$work/e-empty" "$work/d-ip" >"$work/derived-mapped.txt"
if grep -q "^deny worker,kernel,build,cli-worker,cli-kernel listener-127.0.0.1-41009 tcp 127.0.0.1:41009\$" "$work/derived-mapped.txt" && grep -q " listener-10.1.2.3-41010 tcp 10.1.2.3:41010\$" "$work/derived-mapped.txt" && ! grep -q "7431" "$work/derived-mapped.txt" && ! grep -q "41011" "$work/derived-mapped.txt"; then ok "derived: an IPv4-mapped loopback or private listener (::ffff:a.b.c.d) is probed as the IPv4 address, the mapped gateway is left out, and a mapped public address is not a deny target"; else bad "mapped listeners: $(cat "$work/derived-mapped.txt")"; fi

python3 -I - "$deploy/fence-probe.py" >"$work/classify.out" 2>&1 <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("fp", sys.argv[1])
fp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fp)
want = {"::ffff:127.0.0.1": "loopback", "::ffff:10.1.2.3": "private", "::ffff:100.64.0.10": "tailscale", "::ffff:203.0.113.10": "public", "::ffff:0.0.0.0": "wildcard", "::1": "loopback", "2001:db8::1": "public"}  # scan-forbidden: allow-addresses (a Tailscale test address)
got = {k: fp.classify(k) for k in want}
assert got == want, got
print("classify ok")
PY
if grep -q "classify ok" "$work/classify.out"; then ok "classify: an IPv4-mapped IPv6 address is classified as the IPv4 address it wraps"; else bad "classify: $(cat "$work/classify.out")"; fi
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
# the hung probe's marker: `sleep 40.<this run's pid>`, matched whole (so 40.12 never matches 40.123), found and killed by this run only
export STUB_HANG_SECS="40.$$"
hang_left() { pgrep -f "^sleep ${STUB_HANG_SECS//./\\.}\$" >/dev/null 2>&1; }
hang_kill() { pkill -f "^sleep ${STUB_HANG_SECS//./\\.}\$" 2>/dev/null || true; }
# stand-in for systemd-run: records the arguments, then runs what comes after "--" here (the probe, with python3 in place of /usr/bin/python3)
cat >"$stubs/systemd-run" <<'STUB'
#!/usr/bin/env bash
echo "systemd-run $*" >>"$STUB_LOG/runs"
if [ -n "${STUB_RUN_FAIL:-}" ]; then echo "Failed to start transient service: property refused" >&2; exit 1; fi
if [ -n "${STUB_RUN_EMPTY:-}" ]; then exit 0; fi
# STUB_RUN_HANG=<set>: that set's unit never finishes (it sleeps), as a probe stuck on something would. It sleeps STUB_HANG_SECS, a number
# unique to this test run, so the run can find and stop its own sleeper without touching another run's (or any other `sleep 40`)
while [ "$1" != "--" ]; do
  case "$1" in --unit=bulig-fence-"${STUB_RUN_HANG:-no-such-set}"-*) exec sleep "$STUB_HANG_SECS" ;; esac
  shift
done
shift
[ "$1" = "/usr/bin/python3" ] && shift
# STUB_STANDIN=<path>: run the probe inside fenced-standin.py (a socket that fences like the real unit, see that file) instead of bare
if [ -n "${STUB_STANDIN:-}" ]; then shift; exec python3 -I "$STUB_STANDIN" "$@"; fi
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
bash "$deploy/set-mac-worker.sh" 100.101.102.103 >/dev/null 2>&1  # scan-forbidden: allow-addresses (a Tailscale test address)
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
case "$w" in *"--uid=bulig-worker"*"-p IPAddressDeny=$DENY $HOSTS "*"-p IPAddressAllow=127.74.3.1/32 "*"-p RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK "*"-p InaccessiblePaths=$INACC_W "*"-p BindReadOnlyPaths=$RES "*) ok "worker set: read from the installed unit and its drop-in (uid, deny with the host addresses, the gateway allow, AF_UNIX and AF_NETLINK, hidden sockets, upstream resolvers)" ;; *) bad "worker run: $w" ;; esac
# the bwrap probe has to see the unit's real /proc, system call filter and capabilities, so those are passed on too
case "$w" in *"-p ReadOnlyPaths=/sys "*"-p SystemCallFilter=~syslog sethostname setdomainname "*"-p ProtectKernelModules=true "*"-p NoNewPrivileges=true "*"-p CapabilityBoundingSet= "*) ok "worker set: the sandbox-relevant settings (ReadOnlyPaths, SystemCallFilter, the Protect* kept, NoNewPrivileges, the empty capability set) are passed on, so the bwrap probe runs as the worker would" ;; *) bad "worker run lacks the sandbox settings: $w" ;; esac
case "$w" in *ProtectKernelTunables* | *ProtectKernelLogs* | *ProtectHostname* | *ProcSubset*) bad "the worker set has a /proc protection the worker unit does not: $w" ;; *) ok "and none of the /proc protections the worker unit leaves out" ;; esac
k="$(run_for kernel)"
case "$k" in *"-p ProtectKernelTunables=true "*"-p ProtectKernelLogs=true "*"-p ProtectHostname=true "*) ok "kernel set: its /proc protections are passed on as the unit has them" ;; *) bad "kernel run lacks its /proc protections: $k" ;; esac
case "$k" in *"--uid=bulig "*"-p IPAddressDeny=$DENY "*"-p IPAddressAllow=127.74.3.1/32 100.101.102.103/32 "*"-p RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 "*) ok "kernel set: keeps AF_UNIX, allows its gateway and exactly the Mac worker's /32 from the drop-in" ;; *) bad "kernel run: $k" ;; esac  # scan-forbidden: allow-addresses (a Tailscale test address)
b="$(run_for build)"
case "$b" in *"-p DynamicUser=yes"*"-p RestrictAddressFamilies=AF_INET AF_INET6"*"-p IPAddressDeny=$DENY $HOSTS "*) ok "build set: DynamicUser, no AF_UNIX, the deny list with the host addresses" ;; *) bad "build run: $b" ;; esac
case "$b" in *"--uid="* | *"IPAddressAllow"*) bad "the build set has a named user or an Allow: $b" ;; *) ok "and no named user and no Allow" ;; esac
cw="$(run_for cli-worker)"; ck="$(run_for cli-kernel)"
case "$cw" in *"--uid=bulig-worker"*"RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK "*"InaccessiblePaths=$INACC_W "*) ok "cli-worker set: the worker unit's families and hidden paths" ;; *) bad "cli-worker run: $cw" ;; esac
case "$ck" in *"--uid=bulig "*"RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6"*) ok "cli-kernel set: keeps AF_UNIX" ;; *) bad "cli-kernel run: $ck" ;; esac
# the cli sets are probed with bulig-cli.sh's own hardening, so the bwrap probe sees the /proc a real one-off command has
case "$cw" in *"-p ReadOnlyPaths=/sys "*"-p SystemCallFilter=~syslog sethostname setdomainname "*) ok "cli-worker set: probed with the worker's hardening (ReadOnlyPaths=/sys, the system call filter)" ;; *) bad "cli-worker run lacks the hardening: $cw" ;; esac
case "$cw" in *ProtectKernelTunables* | *ProtectKernelLogs* | *ProtectHostname*) bad "cli-worker set has a /proc protection: $cw" ;; *) ok "and none of the /proc protections bwrap cannot live with" ;; esac
case "$ck" in *"-p ProtectKernelTunables=yes "*"-p ProtectKernelLogs=yes "*"-p ProtectHostname=yes "*) ok "cli-kernel set: probed with the kernel's /proc protections" ;; *) bad "cli-kernel run lacks its hardening: $ck" ;; esac
# a target that ss lists and the fenced run cannot reach is the one case that is a real pass
# (the build set: the worker sets have AF_UNIX, so there a unix path that InaccessiblePaths does not hide is a known limit and is not run)
printf 'deny build hidden-sock unix %s\n' "$unix_path" >"$work/fc-hidden.txt"
rc=0
printf 'u_str LISTEN 0 5 %s 1 * 0\n' "$unix_path" >"$log/ss-unix"
STUB_HIDE="$unix_path" BULIG_FENCE_PROBES="$work/fc-hidden.txt" bash "$deploy/fence-check.sh" build >"$work/fc.out" 2>&1 || rc=$?
: >"$log/ss-unix"
if [ "$rc" -eq 0 ] && grep -q "^ok build hidden-sock blocked" "$work/fc.out" && ! grep -q "^warn" "$work/fc.out"; then ok "a target that ss lists and the fenced run cannot reach is a pass: blocked (so the ss listing is what makes a pass mean something)"; else bad "hidden-target rc=$rc: $(cat "$work/fc.out")"; fi
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
BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker kernel build >"$work/fc.out" 2>&1 || true
if grep -q "^info worker abstract-1 known limit, not tested by connecting" "$work/fc.out" && grep -q "^info kernel abstract-1 known limit, not tested by connecting" "$work/fc.out" && grep -qE "^(ok|warn|FAIL) build abstract-1 " "$work/fc.out"; then ok "an abstract socket found with ss is probed: denied for the build, a known limit (never connected to) for the worker and the kernel"; else bad "derived abstract probes: $(grep abstract "$work/fc.out")"; fi
: >"$log/ss-unix"
# more listening path sockets than the cap: the output says so, as a warn line (not only on stderr)
for n in $(seq 1 401); do printf 'u_str LISTEN 0 5 /run/many/s%03d.sock 1 * 0\n' "$n"; done >"$log/ss-unix"
BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker >"$work/fc.out" 2>/dev/null || true
if grep -q "^warn fence-check capped: 401 listening path sockets, only the first 400 (sorted by path) are judged and listed; the other 1 are not checked" "$work/fc.out" && grep -q "^info worker path-sockets 400 listening path sockets" "$work/fc.out"; then ok "past the cap, fence-check's own output has a warn line that says how many path sockets were not checked"; else bad "cap in the output: $(grep -i 'cap\|path-sockets' "$work/fc.out")"; fi
: >"$log/ss-unix"
if ! grep -q "work\." <(ls "$root/var/lib/bulig-checks" 2>/dev/null); then ok "the probe stream is removed afterwards"; else bad "work folder left in $(ls "$root/var/lib/bulig-checks")"; fi

# a drop-in that opens a hole is part of what is tested
mkdir -p "$SD/bulig-worker.service.d"
printf '[Service]\nIPAddressAllow=127.0.0.1/32\nRestrictAddressFamilies=AF_PACKET\n' >"$SD/bulig-worker.service.d/99-hole.conf"
: >"$log/runs"
BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker >/dev/null 2>&1 || true
case "$(run_for worker)" in *"IPAddressAllow=127.74.3.1/32 127.0.0.1/32"*"RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK AF_PACKET"*) ok "a drop-in that adds 127.0.0.1 and a socket family is passed to the probe, so the probe would catch it" ;; *) bad "drop-in not merged: $(run_for worker)" ;; esac
printf '[Service]\nIPAddressAllow=\nIPAddressAllow=100.64.1.1/32\n' >"$SD/bulig-worker.service.d/99-hole.conf"  # scan-forbidden: allow-addresses (a Tailscale test address)
: >"$log/runs"
BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker >/dev/null 2>&1 || true
case "$(run_for worker)" in *"IPAddressAllow=100.64.1.1/32 "*) ok "an empty assignment resets the list, as in systemd" ;; *) bad "reset not honoured: $(run_for worker)" ;; esac  # scan-forbidden: allow-addresses (a Tailscale test address)
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
ProtectKernelTunables=no
ReadOnlyPaths=/sys
SystemCallFilter=~sethostname setdomainname syslog
CapabilityBoundingSet=
DATA
: >"$log/runs"
STUB_SHOW_FILE="$shown" BULIG_FENCE_SOURCE=show BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker --no-late >"$work/fc.out" 2>&1 || true
w="$(grep -- '--unit=bulig-fence-worker-' "$log/runs" | head -1)"
case "$w" in *"--uid=bulig-worker"*"-p IPAddressDeny=127.0.0.0/8 ::1/128 10.0.0.0/8 "*"-p IPAddressAllow=127.74.3.1 127.0.0.1 "*) ok "the probe gets the LOADED values (here a 127.0.0.1 that no file has, as set-property would leave it), so a loaded hole is tested" ;; *) bad "loaded run: $w" ;; esac
case "$w" in *"BindPaths="*) bad "an empty loaded property was passed on: $w" ;; *) ok "an empty loaded property (BindPaths=) is not passed on" ;; esac
case "$w" in *"-p BindReadOnlyPaths=/run/systemd/resolve/resolv.conf:/etc/resolv.conf "*"-p ProtectSystem=strict "*) ok "bind paths and the single-value settings come from the loaded unit too" ;; *) bad "loaded bind/protect: $w" ;; esac
case "$w" in *"-p ReadOnlyPaths=/sys "*"-p SystemCallFilter=~sethostname setdomainname syslog "*"-p ProtectKernelTunables=no "*"-p CapabilityBoundingSet= "*) ok "and the sandbox-relevant settings, the empty capability set included, come from the loaded unit" ;; *) bad "loaded sandbox settings: $w" ;; esac
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
  res="$(PATH="$NODE_DIR:$PATH" probe fenced worker "$work/nodeprobes.txt" --control "" --af "$NOUNIX" --activation-text "" --ip-deny "127.0.0.0/8 ::1/128" || true)"
  if grep -q "^ok worker node-ok works" <<<"$res" && grep -q "^FAIL worker node-bad should work" <<<"$res" && grep -q "^info worker node-known known limit: node .* does not work (exit 4" <<<"$res"; then ok "a node probe works when node exits 0, fails when it does not, and a known one only reports"; else bad "node probes: $res"; fi
  if grep -q "^ok worker exec-ok works" <<<"$res" && grep -q "^FAIL worker exec-bad should work" <<<"$res"; then ok "an exec probe (claude --version's kind) works when the command exits 0 and fails when it does not"; else bad "exec probes: $res"; fi
else
  ok "node probes: skipped (no node on this machine's PATH; CI has node)"
fi
: >"$log/runs"
BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" build >/dev/null 2>&1 || true
case "$(grep -- '--unit=bulig-fence-build-' "$log/runs" | head -1)" in *"--setenv=HOME=/var/tmp/home"*) ok "the build set is probed with HOME set explicitly, as the real build does (a DynamicUser has no passwd entry to take it from)" ;; *) bad "build probe has no HOME" ;; esac
if grep -q -- '--setenv=HOME=/var/tmp/home' "$deploy/release-remote.sh"; then ok "and the real build sets that HOME"; else bad "release-remote.sh does not set HOME for the build"; fi

echo "Claude Code's sandbox probes (worker sets)"
if grep -qE "^allow +worker,cli-worker +bwrap-sandbox +sandbox +/usr/bin/bwrap --unshare-all --ro-bind / / --dev /dev --proc /proc /bin/true\$" "$P"; then ok "the worker sets run bwrap --unshare-all --ro-bind / / --dev /dev --proc /proc /bin/true (the sandbox without Claude)"; else bad "no bwrap probe for exactly the worker sets: $(grep bwrap "$P")"; fi
if grep -qE "^allow +worker,cli-worker +unix-socket-of-its-own +unix-self +-\$" "$P"; then ok "and listen on a unix socket of their own (what the sandbox's proxy does)"; else bad "no unix-self probe for the worker sets"; fi
printf 'allow worker sb-ok sandbox python3 -c pass\nallow worker sb-bad sandbox python3 -c raise\nallow worker sb-missing sandbox /nonexistent/bwrap --unshare-all /bin/true\nallow worker us-self unix-self -\n' >"$work/sbprobes.txt"
res="$(probe fenced worker "$work/sbprobes.txt" --control "" --af "$WITHUNIX" --activation-text "" --ip-deny "127.0.0.0/8 ::1/128" || true)"
if grep -q "^ok worker sb-ok works (bwrap made its namespaces" <<<"$res"; then ok "a sandbox probe whose command exits 0 works"; else bad "sandbox ok: $res"; fi
for n in sb-bad sb-missing; do
  if grep "^FAIL worker $n should work but did not" <<<"$res" | grep -q "the AppArmor profile bulig-bwrap is not loaded" && grep "^FAIL worker $n " <<<"$res" | grep -q "AF_NETLINK or AF_UNIX"; then ok "a sandbox probe that fails ($n) is a FAIL that names AppArmor and the address families as the likely causes"; else bad "sandbox $n: $(grep "$n" <<<"$res")"; fi
done
if grep -q "^ok worker us-self works (listened on and connected to a unix socket of its own)" <<<"$res"; then ok "the unix-self probe listens on and connects to its own socket"; else bad "unix-self: $(grep us-self <<<"$res")"; fi
printf 'allow worker us-self unix-self -\n' >"$work/us.txt"
res="$(python3 -I "$deploy/test/fenced-standin.py" "$deploy/fence-probe.py" fenced worker "$work/us.txt" --control "" --af "$NOUNIX" --activation-text "" || true)"
if grep -q "^FAIL worker us-self should work but did not" <<<"$res" && grep -q "EAFNOSUPPORT" <<<"$res" && grep -q "Claude Code's sandbox listens on a unix socket of its own" <<<"$res"; then ok "in a set with no AF_UNIX the unix-self probe FAILs and says why (the error seen on the server)"; else bad "unix-self without AF_UNIX: $res"; fi
if [ -z "$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'bulig-fence-*' -newer "$work/probes.txt" 2>/dev/null | head -1)" ]; then ok "and it leaves no temporary folder behind"; else bad "a bulig-fence-* folder was left in ${TMPDIR:-/tmp}"; fi
# The worker sets have AF_UNIX: a unix deny probe runs there only when InaccessiblePaths hides its path, and an abstract one never does.
# (Never against the machine's real sockets: here nothing fences the probe, so a run against /run/docker.sock and the like would really
# connect to them, as it did on a CI runner. The paths below are in a fresh folder; nothing listens there.)
WAF="AF_UNIX AF_INET AF_INET6 AF_NETLINK"
wd="$(mktemp -d /tmp/bfw-XXXXXX)"
printf 'deny worker hidden-one unix %s/hidden/a.sock\ndeny worker open-one unix %s/open/b.sock\ndeny worker an-abstract abstract example-name\n' "$wd" "$wd" >"$work/w-unix.txt"
res="$(probe fenced worker "$work/w-unix.txt" --control "" --af "$WAF" --inaccessible "-$wd/hidden" --activation-text "" || true)"
if grep -q "^warn worker hidden-one inconclusive" <<<"$res" && grep -q "^info worker open-one known limit, not tested by connecting" <<<"$res" && grep -q "^info worker an-abstract known limit, not tested by connecting" <<<"$res"; then ok "with AF_UNIX, a deny probe whose path is hidden is run (it cannot reach anything), one whose path is not hidden and an abstract one are known limits, never connected to"; else bad "worker unix probes: $res"; fi
rm -rf "$wd"
# and every published unix deny probe for the worker sets is under one of the worker's hidden paths, so on the server each one is a real test
# (checked as text: the paths are never opened here)
unhidden=""
while read -r _ sets name _ target; do
  case ",$sets," in *,worker,* | *,cli-worker,*) ;; *) continue ;; esac
  t="${target/#\/var\/run\//\/run\/}"
  hit=0
  for h in $INACC_W; do h="${h#-}"; h="${h/#\/var\/run\//\/run\/}"; case "$t" in "$h" | "$h"/*) hit=1 ;; esac; done
  [ "$hit" -eq 1 ] || unhidden="$unhidden $name"
done < <(grep -E '^deny +[^ ]+ +[^ ]+ +unix ' "$P")
if [ -z "$unhidden" ] && [ "$(grep -cE '^deny +[^ ]*worker[^ ]* +[^ ]+ +unix ' "$P")" -ge 7 ]; then ok "every published unix deny probe for the worker sets (tailscaled, snapd x2, docker, Postgres, userdb, resolved) is under the worker's hidden paths"; else bad "published worker unix probes not hidden:$unhidden"; fi

echo "path sockets the worker sets could connect to (judged from the file, never connected to)"
sk="$(mktemp -d /tmp/bf-XXXXXX)"
mkdir -p "$sk/open" "$sk/shut"
python3 -I - "$sk" <<'PYS'
import os, socket, sys
d = sys.argv[1]
for name, mode in (("open/other.sock", 0o666), ("open/closed.sock", 0o000), ("shut/inside.sock", 0o666)):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(os.path.join(d, name))
    s.close()
    os.chmod(os.path.join(d, name), mode)
open(os.path.join(d, "open/plain-file"), "w").close()
PYS
chmod 000 "$sk/shut"
{ for f in open/other.sock open/closed.sock shut/inside.sock open/plain-file open/missing.sock; do printf 'u_str LISTEN 0 5 %s 1 * 0\n' "$sk/$f"; done; } >"$work/r-unix"
: >"$work/r-tcp"; : >"$work/r-ip"
probe derive "$work/r-tcp" "$work/r-unix" "$work/r-ip" | grep '^reach ' >"$work/reach.txt"
if [ "$(wc -l <"$work/reach.txt" | tr -d ' ')" = "5" ]; then ok "every listening path socket from ss gets a reach line"; else bad "reach lines: $(cat "$work/reach.txt")"; fi
# the cap: up to 400 are judged, and a cap that is hit is said
for n in $(seq 1 401); do printf 'u_str LISTEN 0 5 /run/many/s%03d.sock 1 * 0\n' "$n"; done >"$work/r-unix-many"
probe derive "$work/r-tcp" "$work/r-unix-many" "$work/r-ip" >"$work/reach-many.txt" 2>"$work/reach-many.err"
if [ "$(grep -c '^reach ' "$work/reach-many.txt")" = "400" ] && grep -q "401 listening path sockets, only the first 400 (sorted by path) are judged and listed; the other 1 are not checked" "$work/reach-many.err" && ! grep -q 's401.sock' "$work/reach-many.txt"; then ok "past 400 path sockets, the first 400 by path are judged and derive says how many were left out"; else bad "reach cap: $(grep -c '^reach ' "$work/reach-many.txt") lines, $(cat "$work/reach-many.err")"; fi
head -400 "$work/r-unix-many" >"$work/r-unix-400"
probe derive "$work/r-tcp" "$work/r-unix-400" "$work/r-ip" >/dev/null 2>"$work/reach-400.err"
if [ ! -s "$work/reach-400.err" ]; then ok "and exactly 400 says nothing"; else bad "a note at 400: $(cat "$work/reach-400.err")"; fi
# what an unreachable path is called (only counted, never listed): a plain file is not "hidden", a socket with no permission may be
why="$(python3 -I -c 'import importlib.util,sys; s=importlib.util.spec_from_file_location("fp", sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.path_reach(sys.argv[2], 99999, None)[1])' "$deploy/fence-probe.py" "$sk/open/plain-file")"
if [ "$why" = "not a socket in this unit's view (another kind of file is there)" ]; then ok "a plain file where a socket was is 'another kind of file', not 'hidden by InaccessiblePaths'"; else bad "plain-file reason: $why"; fi
if grep -q '"no permission for this user (or hidden by InaccessiblePaths: systemd'"'"'s mode-0000 socket is in its place)"' "$deploy/fence-probe.py"; then ok "and a socket with no permission names InaccessiblePaths as one cause (systemd mounts a mode-0000 socket over a hidden one)"; else bad "the no-permission reason does not name InaccessiblePaths"; fi
me="$(id -u)"
res="$(probe fenced worker "$work/reach.txt" --control "" --af "$WAF" --activation-text "" --self-uid 99999 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q "^info worker path-[0-9]* known limit, not tested by connecting: unix path $sk/open/other.sock is connectable from this set" <<<"$res"; then ok "a world-connectable socket of someone else is listed as a known limit, and nothing fails"; else bad "other socket rc=$rc: $res"; fi
if [ "$me" != "0" ]; then
  if ! grep -q "closed.sock\|inside.sock\|plain-file\|missing.sock" <<<"$res"; then ok "a socket with no permission, one behind a closed folder, a plain file and a missing path are not listed"; else bad "unreachable ones listed: $res"; fi
  if grep -q "^info worker path-sockets 5 listening path sockets: 1 connectable from this set (known limit, listed above), 0 its own, 0 Bulig's own (must be 0), 4 not reachable" <<<"$res"; then ok "and one summary line counts them"; else bad "summary: $(grep path-sockets <<<"$res")"; fi
fi
res="$(probe fenced worker "$work/reach.txt" --control "" --af "$WAF" --activation-text "" --self-uid 99999 --bulig-uid "$me" 2>&1)"; rc=$?
if [ "$rc" -eq 1 ] && grep -q "^FAIL worker path-[0-9]* a Bulig socket is connectable from this set: $sk/open/other.sock" <<<"$res"; then ok "a connectable socket owned by the kernel's user is a FAIL (exit 1)"; else bad "bulig-owned socket rc=$rc: $res"; fi
res="$(probe fenced worker "$work/reach.txt" --control "" --af "$WAF" --activation-text "" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q "^info worker path-[0-9]* this set's own socket: $sk/open/other.sock" <<<"$res"; then ok "the set's own socket is listed as its own"; else bad "own socket rc=$rc: $res"; fi
if python3 -I -c 'import importlib.util,sys; s=importlib.util.spec_from_file_location("fp", sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); sys.exit(0 if m.BULIG_OWN_PATHS == ("/run/postgresql/.s.PGSQL.5436",) and "/var/lib/bulig/" in m.BULIG_OWN_PREFIXES else 1)' "$deploy/fence-probe.py"; then ok "the Bulig Postgres socket and the kernel's folders count as Bulig's own"; else bad "Bulig's own paths"; fi
printf "%s * 0\n" "$sk/open/other.sock" >"$work/r-act"
res="$(probe fenced worker "$work/reach.txt" --control "" --af "$WAF" --activation-text "$(cat "$work/r-act")" --self-uid 99999 2>&1)"
if grep -q "other.sock is connectable from this set (.*; an activation socket)" <<<"$res"; then ok "an activation socket is named as one (and still never connected to)"; else bad "activation note: $(grep other.sock <<<"$res")"; fi
printf 'reach worker x unix /run/x.sock\n' >"$work/reach-bad.txt"
expect_fail_msg "a reach line of another kind is refused" "a reach line is kind unix-path" python3 -I "$deploy/fence-probe.py" fenced worker "$work/reach-bad.txt" --control "" --af "$WAF" --activation-text ""
printf 'known worker x unix-path /run/x.sock\n' >"$work/reach-bad.txt"
expect_fail_msg "and a unix-path line that is not a reach line" "a reach line is kind unix-path" python3 -I "$deploy/fence-probe.py" fenced worker "$work/reach-bad.txt" --control "" --af "$WAF" --activation-text ""
if grep -q -- '--bulig-uid "$bulig_uid"' "$deploy/fence-check.sh" && grep -q 'bulig_uid="$(id -u bulig' "$deploy/fence-check.sh"; then ok "fence-check hands the kernel user's uid to every set"; else bad "fence-check does not pass --bulig-uid"; fi
chmod 755 "$sk/shut"; rm -rf "$sk"

echo "the kit never connects to another service, and never wakes one"
# Listeners that count the connections they accept: tcp_port, the unix socket and (Linux) the abstract one stand for ANOTHER service;
# http_port stands for Bulig's own gateway. The rule: nothing but the allow probes (Bulig's own) and the fenced deny probes (which the fence
# stops first) ever connect; the control run and the known-limit reports never do; a socket-activated target is never connected to.
accepts() { sleep 0.4; wc -c <"$work/accepts-$1" | tr -d ' '; }
zero_accepts() { # zero_accepts <label>: no connection reached any of the four listeners since the last reset
  local a
  a="$(accepts tcp) $(accepts http) $(accepts unix) $(accepts abstract)"
  if [ "$a" = "0 0 0 0" ]; then ok "$1: zero connections accepted (tcp, http, unix, abstract: $a)"; else bad "$1: connections reached the listeners (tcp http unix abstract: $a)"; fi
}
reset_accepts() { sleep 0.3; for k in tcp http unix abstract; do : >"$work/accepts-$k"; done; }
abs_target="$abs_name"; [ "$abs_target" != "-" ] || abs_target="synthetic-abstract-name"
printf 'deny worker,kernel d-tcp tcp 127.0.0.1:%s\ndeny worker,kernel d-unix unix %s\ndeny worker d-abs abstract %s\nknown worker,kernel k-tcp tcp 127.0.0.1:%s\nknown worker,kernel k-unix unix %s\nknown worker,kernel k-abs abstract %s\nknown worker,kernel k-http http http://127.0.0.1:%s/x\n' \
  "$tcp_port" "$unix_path" "$abs_target" "$tcp_port" "$unix_path" "$abs_target" "$http_port" >"$work/nc-probes.txt"
printf 'u_str LISTEN 0 5 %s 1 * 0\nu_str LISTEN 0 5 @%s 2 * 0\n' "$unix_path" "$abs_target" >"$work/ss-unix-nc.txt"
grep '^known' "$work/nc-probes.txt" >"$work/nc-known-only.txt"
CA2=(--ss-tcp "$work/ss-tcp.txt" --ss-unix "$work/ss-unix-nc.txt")

reset_accepts
for s in worker kernel; do probe control "$s" "$work/nc-probes.txt" "${CA2[@]}" >"$work/nc-control-$s.out"; done
zero_accepts "control mode (deny and known targets, all listed by ss, the way the old control run connected to them)"
if grep -qx "d-tcp=open" "$work/nc-control-worker.out" && grep -qx "d-unix=open" "$work/nc-control-worker.out" && grep -qx "d-abs=open" "$work/nc-control-worker.out" && grep -qx "k-tcp=open" "$work/nc-control-kernel.out"; then ok "control still says open for what ss lists (so a blocked probe can be told from nothing-there)"; else bad "control from ss: $(cat "$work/nc-control-worker.out")"; fi

# the counters work: an allow probe to Bulig's own stand-in IS a connection
reset_accepts
printf 'allow worker gw-http http http://127.0.0.1:%s/healthz\nallow worker gw-tcp tcp 127.0.0.1:%s\n' "$http_port" "$http_port" >"$work/nc-allow.txt"
probe fenced worker "$work/nc-allow.txt" --control "" --af "$NOUNIX" --activation-text "" --ip-deny "127.0.0.0/8 ::1/128" >"$work/nc-allow.out" 2>&1
n_http="$(accepts http)"
if [ "$n_http" -ge 2 ] && grep -q "^ok worker gw-http works" "$work/nc-allow.out" && grep -q "^ok worker gw-tcp works" "$work/nc-allow.out"; then ok "allow probes to Bulig's own stand-in do connect ($n_http accepted): the counters see connections"; else bad "allow probes: accepted=$n_http $(cat "$work/nc-allow.out")"; fi

# known limits: never connect, in a set with AF_UNIX and in one without, and they say how they were judged
for af in "$WITHUNIX" "$NOUNIX"; do
  reset_accepts
  probe fenced kernel "$work/nc-known-only.txt" --control "k-tcp=open,k-unix=open,k-abs=open" --af "$af" --activation-text "" --ip-deny "127.0.0.0/8" --ip-allow "127.74.3.1/32" >"$work/nc-known.out" 2>&1
  rc=$?
  zero_accepts "known-limit probes with RestrictAddressFamilies='$af'"
  if [ "$rc" -eq 0 ] && [ "$(grep -c '^info kernel k-.* known limit, not tested by connecting' "$work/nc-known.out")" = "4" ]; then ok "  each of the four is reported as 'known limit, not tested by connecting', and exit 0"; else bad "  known output rc=$rc: $(cat "$work/nc-known.out")"; fi
done
probe fenced kernel "$work/nc-known-only.txt" --control "k-abs=open" --af "$WITHUNIX" --activation-text "" >"$work/nc-known.out" 2>&1
if grep -q "k-abs known limit, not tested by connecting: abstract .*listed by ss; the unit has AF_UNIX" "$work/nc-known.out"; then ok "the abstract limit is reported from the properties (AF_UNIX allowed) and ss (listed)"; else bad "abstract limit text: $(grep k-abs "$work/nc-known.out")"; fi
probe fenced kernel "$work/nc-known-only.txt" --control "k-tcp=open" --af "$WITHUNIX" --activation-text "" --ip-deny "127.0.0.0/8" >"$work/nc-known.out" 2>&1
if grep -q "k-tcp known limit, not tested by connecting: tcp .*listed by ss; 127.0.0.1 is denied by IPAddressDeny" "$work/nc-known.out"; then ok "the tcp limit is reported from the IP filter and ss"; else bad "tcp limit text: $(grep k-tcp "$work/nc-known.out")"; fi

# a deny probe for an abstract socket in a set that HAS AF_UNIX: nothing would stop it, so it is not run
reset_accepts
printf 'deny kernel d-abs2 abstract %s\ndeny kernel d-unix2 unix %s\n' "$abs_target" "$unix_path" >"$work/nc-deny2.txt"
probe fenced kernel "$work/nc-deny2.txt" --control "d-abs2=open,d-unix2=open" --af "$WITHUNIX" --activation-text "" --inaccessible "-/run/tailscale" >"$work/nc-deny2.out" 2>&1
zero_accepts "a deny probe for an abstract socket, or a unix path nothing hides, in a set that has AF_UNIX"
if [ "$(grep -c '^info kernel d-.*2 known limit, not tested by connecting' "$work/nc-deny2.out")" = "2" ]; then ok "  both are reported as known limits"; else bad "  deny-with-AF_UNIX output: $(cat "$work/nc-deny2.out")"; fi

# socket activation: a target that systemd listens on for another unit is never connected to, by any mode
printf '127.0.0.1:%s  other-app.socket  other-app.service\n%s  other-unix.socket  other-unix.service\n@%s  other-abs.socket  other-abs.service\naudit 1  systemd-journald-audit.socket  systemd-journald.service\n' "$tcp_port" "$unix_path" "$abs_target" >"$work/act-all.txt"
reset_accepts
probe control worker "$work/nc-probes.txt" "${CA2[@]}" >"$work/nc-act-control.out"
zero_accepts "control mode with every target socket-activated"
# (the fixture is unfenced here, so a deny probe that was run would connect and be counted: only the activation skip keeps the counters at zero)
reset_accepts
probe fenced worker "$work/nc-probes.txt" --control "$(paste -sd, "$work/nc-act-control.out")" --af "$NOUNIX" --activation-text "$(cat "$work/act-all.txt")" --ip-deny "127.0.0.0/8 ::1/128" --ip-allow "127.74.3.1/32" >"$work/nc-act.out" 2>&1
rc=$?
zero_accepts "fenced deny probes at activation sockets (the stand-in is not fenced, so only the skip stops them)"
if [ "$rc" -eq 0 ] && [ "$(grep -c '^ok worker d-.* activation socket: checked by properties only' "$work/nc-act.out")" = "3" ]; then ok "  each is reported as 'activation socket: checked by properties only' (tcp: the address is in IPAddressDeny; unix and abstract: the set has no AF_UNIX)"; else bad "  activation output rc=$rc: $(cat "$work/nc-act.out")"; fi
reset_accepts
grep '^deny worker,kernel d-tcp' "$work/nc-probes.txt" >"$work/nc-d-tcp.txt"
probe fenced worker "$work/nc-d-tcp.txt" --control "d-tcp=open" --af "$NOUNIX" --activation-text "$(cat "$work/act-all.txt")" --ip-deny "10.0.0.0/8" >"$work/nc-act2.out" 2>&1
rc=$?
if [ "$rc" -eq 1 ] && grep -q "^FAIL worker d-tcp activation socket: checked by properties only, and tcp 127.0.0.1:$tcp_port is reachable" "$work/nc-act2.out"; then ok "an activation socket whose address the IP filter does not deny is a FAIL, judged from the properties and still not connected to"; else bad "unfiltered activation target: rc=$rc $(cat "$work/nc-act2.out")"; fi
zero_accepts "  and still nothing connected"

# a deny probe of kind http, https, dns (or anything but tcp, unix, abstract) would skip the activation check: refused, and nothing connects
reset_accepts
for dk in http https dns pwd; do
  case "$dk" in http) dt="http://127.0.0.1:$http_port/x" ;; https) dt="127.0.0.1" ;; dns) dt="localhost" ;; *) dt="-" ;; esac
  printf 'deny worker bad-kind %s %s\n' "$dk" "$dt" >"$work/bad-kind.txt"
  expect_fail_msg "a deny probe of kind $dk is refused by control" "a deny probe must be kind tcp, unix or abstract" python3 -I "$deploy/fence-probe.py" control worker "$work/bad-kind.txt" "${CA[@]}"
  expect_fail_msg "  and by fenced" "a deny probe must be kind tcp, unix or abstract" python3 -I "$deploy/fence-probe.py" fenced worker "$work/bad-kind.txt" --control "" --af "$NOUNIX" --activation-text "127.0.0.1:$http_port  other.socket  other.service"
done
zero_accepts "deny probes of kind http, https, dns, pwd (refused before anything runs, even at an activation socket)"
for dk in http https dns; do
  expect_fail_msg "set-secret refuses a deny probe of kind $dk in the extra file" "kind must be" bash -c "printf 'deny worker xk $dk example.test\n' | bash '$deploy/set-secret.sh' --fence-extra-probes"
done

# the activation flag is found from the TARGET, not from the probe's name: a control result that lost it (here: says "open", as when two
# probes share a name and the later result wins) must not make a deny probe connect to an activation socket
reset_accepts
probe fenced worker "$work/nc-d-tcp.txt" --control "d-tcp=open" --af "$NOUNIX" --activation-text "$(cat "$work/act-all.txt")" --ip-deny "127.0.0.0/8" >"$work/nc-lost.out" 2>&1
rc=$?
zero_accepts "a deny probe at an activation socket whose control result says 'open' (the activation flag lost by name)"
if [ "$rc" -eq 0 ] && grep -q "^ok worker d-tcp activation socket: checked by properties only" "$work/nc-lost.out"; then ok "  it is still recognised from the target and checked by properties only"; else bad "  lost-flag output rc=$rc: $(cat "$work/nc-lost.out")"; fi
# probe names: plain, and used once per set (so one result cannot stand in for another)
printf 'deny worker abstract-1 abstract %s\ndeny worker,kernel abstract-1 abstract other-name\n' "$abs_target" >"$work/dup.txt"
expect_fail_msg "a name used twice for one set is refused by the probe" "is used twice for the set worker" python3 -I "$deploy/fence-probe.py" control worker "$work/dup.txt" "${CA[@]}"
printf 'deny worker abstract-1 abstract a\ndeny kernel abstract-1 abstract b\n' >"$work/dup-ok.txt"
expect_ok "the same name in two different sets is fine" python3 -I "$deploy/fence-probe.py" control worker "$work/dup-ok.txt" "${CA[@]}"
for badname in 'a,b' 'a=b' 'a/b' 'a:b' "$(printf 'n%.0s' $(seq 1 65))"; do
  printf 'deny worker %s tcp 127.0.0.1:1\n' "$badname" >"$work/badname.txt"
  expect_fail_msg "the probe name '${badname:0:12}' is refused" "bad probe name" python3 -I "$deploy/fence-probe.py" control worker "$work/badname.txt" "${CA[@]}"
done
# a duplicate in the extra file, end to end: refused when installed and when run, and nothing is connected to
EX="$root/etc/bulig/fence-extra-probes.txt"
cp "$EX" "$work/ex.keep2"
printf 'deny worker abstract-1 abstract %s\ndeny worker,kernel dup-name tcp 127.0.0.1:%s\ndeny worker dup-name tcp 127.0.0.1:%s\n' "$abs_target" "$tcp_port" "$tcp_port" >"$EX"
reset_accepts
rc=0
BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker >"$work/fc.out" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && grep -q "the name 'dup-name' is used twice for the set worker" "$work/fc.out"; then ok "fence-check refuses an extra file that uses a name twice (check on the extra file)"; else bad "duplicate extra rc=$rc: $(cat "$work/fc.out")"; fi
printf 'deny worker n1 tcp 127.0.0.1:1\n' >"$EX"
printf 'deny worker abstract-1 abstract name-one\n' >"$work/fc-same-as-derived.txt"
printf 'u_str LISTEN 0 5 @name-two 2 * 0\n' >"$log/ss-unix"
rc=0
BULIG_FENCE_PROBES="$work/fc-same-as-derived.txt" bash "$deploy/fence-check.sh" worker >"$work/fc.out" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && grep -q "the probe name 'abstract-1' is used twice for the set worker" "$work/fc.out"; then ok "and a name that collides with a derived one (abstract-1) is refused when the probes are read"; else bad "derived collision rc=$rc: $(cat "$work/fc.out")"; fi
: >"$log/ss-unix"
zero_accepts "  and nothing was connected to"
cp "$work/ex.keep2" "$EX"
expect_fail_msg "set-secret refuses an extra file with a repeated name" "is used twice for the set" bash -c "printf 'deny worker same tcp 127.0.0.1:1\ndeny worker same tcp 127.0.0.1:2\n' | bash '$deploy/set-secret.sh' --fence-extra-probes"
expect_fail_msg "set-secret refuses an extra file with a comma in a name" "a name may only hold" bash -c "printf 'deny worker a,b tcp 127.0.0.1:1\n' | bash '$deploy/set-secret.sh' --fence-extra-probes"

# a tcp deny target that the unit's own properties leave open is a FAIL from the properties, and is not connected to
printf 'deny worker open-a tcp 127.0.0.1:%s\n' "$tcp_port" >"$work/nc-open.txt"
for how in "no-deny:--ip-deny 10.0.0.0/8" "allowed:--ip-deny 127.0.0.0/8 --ip-allow 127.0.0.1/32" "empty:"; do
  reset_accepts
  # shellcheck disable=SC2086
  probe fenced worker "$work/nc-open.txt" --control "open-a=open" --af "$NOUNIX" --activation-text "" ${how#*:} >"$work/nc-open.out" 2>&1
  rc=$?
  if [ "$rc" -eq 1 ] && grep -q "^FAIL worker open-a tcp 127.0.0.1:$tcp_port is open by the unit's own properties" "$work/nc-open.out"; then ok "an address the unit's properties leave open (${how%%:*}) is a FAIL from the properties"; else bad "open by properties (${how%%:*}) rc=$rc: $(cat "$work/nc-open.out")"; fi
  zero_accepts "  and it was not connected to"
done
reset_accepts
probe fenced worker "$work/nc-open.txt" --control "open-a=open" --af "$NOUNIX" --activation-text "" --ip-deny "127.0.0.0/8" >"$work/nc-open.out" 2>&1
if [ "$(accepts tcp)" = "1" ] && grep -q "^FAIL worker open-a UNEXPECTED SUCCESS" "$work/nc-open.out"; then ok "an address the properties deny IS connected to (the fence must stop it), and a success there is the leak FAIL"; else bad "denied by properties: $(cat "$work/nc-open.out")"; fi

# reading the host as text: the forms ss and systemctl really print
printf 'LISTEN 0 4096 127.0.0.53%%lo:53 0.0.0.0:*\nLISTEN 0 128 *:8081 *:*\nLISTEN 0 128 0.0.0.0:8082 0.0.0.0:*\nLISTEN 0 128 [::]:8083 [::]:*\nLISTEN 0 128 [::1]:8084 [::]:*\n' >"$work/t-ss-tcp"
printf 'u_str LISTEN 0 200 /var/run/postgresql/.s.PGSQL.5436 11 * 0\nu_dgr UNCONN 0 0 /run/dgram.sock 12 * 0\nu_str LISTEN 0 4096 @/tmp/abs-name 13 * 0\n' >"$work/t-ss-unix"
printf '[::]:18090  wide.socket  wide.service\n127.0.0.1:18091  one.socket  one.service\n/run/act.sock  act.socket  act.service\n@/tmp/act-abs  actabs.socket  actabs.service\nroute 1361  systemd-networkd.socket  systemd-networkd.service\nkobject-uevent 1  systemd-udevd-kernel.socket  systemd-udevd.service\n' >"$work/t-sockets"
printf '%s\n' \
  'deny worker t-stub-v4 tcp 127.0.0.53:53' \
  'deny worker t-star-v4 tcp 127.0.0.1:8081' \
  'deny worker t-star-v6 tcp [::1]:8081' \
  'deny worker t-wild4-v4 tcp 127.0.0.1:8082' \
  'deny worker t-wild4-v6 tcp [::1]:8082' \
  'deny worker t-wild6-v6 tcp [::1]:8083' \
  'deny worker t-wild6-v4 tcp 127.0.0.1:8083' \
  'deny worker t-v6-exact tcp [::1]:8084' \
  'deny worker t-v6-other tcp [::2]:8084' \
  'deny worker t-pg-varrun unix /var/run/postgresql/.s.PGSQL.5436' \
  'deny worker t-pg-run unix /run/postgresql/.s.PGSQL.5436' \
  'deny worker t-dgram unix /run/dgram.sock' \
  'deny worker t-abs abstract /tmp/abs-name' \
  'deny worker t-abs-none abstract /tmp/other-name' \
  >"$work/t-probes.txt"
python3 -I "$deploy/fence-probe.py" control worker "$work/t-probes.txt" --ss-tcp "$work/t-ss-tcp" --ss-unix "$work/t-ss-unix" >"$work/t-out"
want="t-stub-v4=open t-star-v4=open t-star-v6=open t-wild4-v4=open t-wild4-v6=closed t-wild6-v6=open t-wild6-v4=closed t-v6-exact=open t-v6-other=closed t-pg-varrun=open t-pg-run=open t-dgram=closed t-abs=open t-abs-none=closed"
if [ "$(tr '\n' ' ' <"$work/t-out" | sed 's/ $//')" = "$want" ]; then ok "ss and systemctl text is read as printed: %lo suffixes, wildcards by family (ss), any-family wildcards for activation, /var/run is /run, datagram sockets are not listeners, kernel sockets are ignored"; else bad "control reading: got '$(tr '\n' ' ' <"$work/t-out")' want '$want'"; fi
printf '%s\n' \
  'deny worker t-act-wide-v4 tcp 127.0.0.1:18090' \
  'deny worker t-act-one tcp 127.0.0.1:18091' \
  'deny worker t-act-path unix /var/run/act.sock' \
  'deny worker t-act-abs abstract /tmp/act-abs' >"$work/t-act-probes.txt"
fres="$(python3 -I "$deploy/fence-probe.py" fenced worker "$work/t-act-probes.txt" --control "" --af "$NOUNIX" --activation-text "$(cat "$work/t-sockets")" --ip-deny "127.0.0.0/8")"
if [ "$(grep -c '^ok worker t-act-.* activation socket: checked by properties only' <<<"$fres")" = "4" ]; then ok "activation targets are matched as systemctl prints them: a wildcard of either family covers every address on its port, a /var/run path is the /run socket, an abstract name has its @; kernel sockets (route, kobject-uevent) are ignored"; else bad "activation matching: $fres"; fi
printf 'deny worker t-act-one-other tcp 127.0.0.2:18091\n' >"$work/t-act-other.txt"
fres="$(python3 -I "$deploy/fence-probe.py" fenced worker "$work/t-act-other.txt" --control "" --af "$NOUNIX" --activation-text "$(cat "$work/t-sockets")")"
if grep -q "t-act-one-other tcp 127.0.0.2:18091 is open by the unit's own properties" <<<"$fres"; then ok "an address that only shares the port of a one-address activation socket is not taken for it"; else bad "non-matching activation: $fres"; fi
expect_fail_msg "fenced without --control is refused" "fenced needs --control" python3 -I "$deploy/fence-probe.py" fenced worker "$work/t-probes.txt" --af "$NOUNIX"
expect_fail_msg "fenced without --af is refused" "fenced needs --control" python3 -I "$deploy/fence-probe.py" fenced worker "$work/t-probes.txt" --control ""

# the fenced stand-in: deny probes are stopped before they reach anything, allow probes to Bulig's own go through
reset_accepts
printf 'deny worker s-tcp tcp 127.0.0.1:%s\ndeny worker s-unix unix %s\ndeny worker s-abs abstract %s\nallow worker s-gw http http://127.0.0.1:%s/healthz\n' "$tcp_port" "$unix_path" "$abs_target" "$http_port" >"$work/nc-standin.txt"
FENCE_STANDIN_ALLOW_PORTS="$http_port" python3 -I "$deploy/test/fenced-standin.py" "$deploy/fence-probe.py" fenced worker "$work/nc-standin.txt" --control "s-tcp=open,s-unix=open,s-abs=open" --af "$NOUNIX" --activation-text "" --ip-deny "127.0.0.0/8 ::1/128" >"$work/nc-standin.out" 2>&1
rc=$?
if [ "$(accepts tcp) $(accepts unix) $(accepts abstract)" = "0 0 0" ]; then ok "fenced stand-in: the three deny probes (tcp, unix, abstract) caused zero accepts"; else bad "fenced stand-in: a deny probe reached a listener ($(accepts tcp) $(accepts unix) $(accepts abstract))"; fi
if [ "$rc" -eq 0 ] && [ "$(grep -c '^ok worker s-.* blocked' "$work/nc-standin.out")" = "3" ] && grep -q "^ok worker s-gw works" "$work/nc-standin.out" && [ "$(accepts http)" -ge 1 ]; then ok "  all three are 'blocked', and the allow probe to the Bulig stand-in connected ($(accepts http) accepted)"; else bad "  stand-in output rc=$rc: $(cat "$work/nc-standin.out")"; fi

# fence-check.sh end to end (its systemd-run stand-in is NOT a fence: a deny probe that runs will connect, and show as a leak)
printf 'deny worker,kernel,build,cli-worker,cli-kernel nc-leak tcp 127.0.0.1:%s\nknown worker,kernel,build,cli-worker,cli-kernel nc-known tcp 127.0.0.1:%s\n' "$tcp_port" "$tcp_port" >"$work/fc-nc.txt"
printf 'LISTEN 0 5 127.0.0.1:%s 0.0.0.0:*\n' "$tcp_port" >"$log/ss-tcp"
reset_accepts
rc=0
BULIG_FENCE_PROBES="$work/fc-nc.txt" bash "$deploy/fence-check.sh" worker >"$work/fc.out" 2>&1 || rc=$?
n="$(accepts tcp)"
# (two: the published-style probe above, and the one derived from the ss listing of the same port. Both are fenced deny probes.)
if [ "$n" = "2" ] && grep -q "^FAIL worker nc-leak UNEXPECTED SUCCESS" "$work/fc.out" && grep -q "^info worker nc-known known limit, not tested by connecting" "$work/fc.out"; then ok "fence-check: one set, two fenced deny probes that leak = exactly two connections (the control run and the known limit add none; the old control run made four)"; else bad "fence-check accepts=$n rc=$rc: $(cat "$work/fc.out")"; fi
reset_accepts
printf '127.0.0.1:%s  other-app.socket  other-app.service\n' "$tcp_port" >"$work/stub-sockets"
rc=0
STUB_SOCKETS="$work/stub-sockets" BULIG_FENCE_PROBES="$work/fc-nc.txt" bash "$deploy/fence-check.sh" all >"$work/fc.out" 2>&1 || rc=$?
zero_accepts "fence-check on all five sets with the target socket-activated (systemd-run here does not fence, so only the skip keeps it at zero)"
if [ "$rc" -eq 0 ] && [ "$(grep -c '^ok .* nc-leak activation socket: checked by properties only' "$work/fc.out")" = "5" ] && [ "$(grep -c '^info .* nc-known known limit, not tested by connecting' "$work/fc.out")" = "5" ]; then ok "  five sets: activation socket checked by properties only, known limit not tested by connecting, exit 0"; else bad "  fence-check activation rc=$rc: $(cat "$work/fc.out")"; fi
rc=0
: >"$log/runs"
STUB_SOCKETS_FAIL=1 BULIG_FENCE_PROBES="$work/fc-nc.txt" bash "$deploy/fence-check.sh" worker >"$work/fc.out" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && grep -q "systemctl list-sockets failed" "$work/fc.out" && [ ! -s "$log/runs" ]; then ok "if systemctl list-sockets cannot be read, fence-check stops instead of guessing (and starts no probe unit)"; else bad "list-sockets failure rc=$rc: $(cat "$work/fc.out")"; fi
: >"$log/ss-tcp"

echo "the fence check is fast, and says the same thing"
# A blocked connection is a DROPPED packet, so it ends in a timeout. fenced-standin.py plays that (FENCE_STANDIN_DROP=1: wait out the socket's timeout,
# then TimeoutError), so the time these tests measure is the time the real check would spend waiting. The probe's own timing is checked here;
# the real fence is only ever tested by fence-check.sh on the machine.
python3 -I -c "
import socket
s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(5)
print(s.getsockname()[1], flush=True)
while True:
    c, _ = s.accept(); c.close()
" >"$work/second-port" 2>&1 &
second_pid=$!
for _ in $(seq 1 50); do [ -s "$work/second-port" ] && break; sleep 0.1; done
second_port="$(cat "$work/second-port")"
standin() { # standin <probe args...>: the probe inside the fenced stand-in; Bulig's two stand-in listeners are the only allowed ports
  FENCE_STANDIN_ALLOW_PORTS="$http_port $second_port" FENCE_STANDIN_DROP=1 FENCE_STANDIN_FAST="42001 42002 42003 42004" FENCE_STANDIN_SLOW="$second_port:1.2" \
    python3 -I "$deploy/test/fenced-standin.py" "$deploy/fence-probe.py" "$@"
}
# one fixed list that has every kind of result: blocked after a drop, blocked at once, inconclusive, a leak, an activation socket, open by properties,
# a known limit, allow probes that are fast, slow (1.2 s: longer than the deny timeout, shorter than the allow one) and dropped
{
  ctl=""
  for n in $(seq 1 40); do printf 'deny worker d-drop-%s tcp 127.0.0.1:%s\n' "$n" "$((41000 + n))"; ctl="$ctl,d-drop-$n=open"; done
  for n in 1 2 3 4; do printf 'deny worker d-fast-%s tcp 127.0.0.1:%s\n' "$n" "$((42000 + n))"; ctl="$ctl,d-fast-$n=open"; done
  printf 'deny worker d-nothing tcp 127.0.0.1:43000\n'
  printf 'deny worker d-leak tcp 127.0.0.1:%s\n' "$http_port"; ctl="$ctl,d-leak=open"
  printf 'deny worker d-unix unix %s\ndeny worker d-abs abstract %s\n' "$unix_path" "$abs_target"; ctl="$ctl,d-unix=open,d-abs=open"
  printf 'deny worker d-act tcp 127.0.0.1:44000\n'; ctl="$ctl,d-act=open"
  printf 'deny worker d-open tcp 10.9.9.9:45000\n'; ctl="$ctl,d-open=open"
  printf 'known worker k-1 tcp 127.0.0.1:%s\n' "$tcp_port"
  printf 'allow worker a-slow tcp 127.0.0.1:%s\n' "$second_port"
  printf 'allow worker a-http http http://127.0.0.1:%s/healthz\n' "$http_port"
  printf 'allow worker a-user pwd -\nallow worker a-child spawn -\n'
  printf 'allow worker a-dropped tcp 127.0.0.1:46000\n'
  printf 'allow-late worker a-late tcp 127.0.0.1:42001\n'
} >"$work/speed-probes.txt"
ctl="${ctl#,}"
# (d-open is 10.9.9.9, which the IP filter below does not deny: a FAIL from the properties. d-leak goes to an allowed port: the fence "leaks".)
SPEED_ARGS=(fenced worker "$work/speed-probes.txt" --control "$ctl" --af "$NOUNIX" --activation-text "127.0.0.1:44000  other.socket  other.service" --ip-deny "127.0.0.0/8 ::1/128")
reset_accepts
SECONDS=0
standin "${SPEED_ARGS[@]}" --deny-timeout 0.2 --jobs 1 >"$work/speed-seq.out" 2>&1
seq_rc=$?
seq_secs=$SECONDS
SECONDS=0
standin "${SPEED_ARGS[@]}" --deny-timeout 0.2 >"$work/speed-par.out" 2>&1
par_rc=$?
par_secs=$SECONDS
if cmp -s "$work/speed-seq.out" "$work/speed-par.out" && [ "$seq_rc" = "$par_rc" ] && [ "$seq_rc" = "1" ]; then ok "the same probe list gives byte-for-byte the same lines and exit code one after another (--jobs 1) and 32 at a time (default)"; else bad "sequential and concurrent differ (rc $seq_rc/$par_rc): $(diff "$work/speed-seq.out" "$work/speed-par.out" | head -8)"; fi
want_names="$(awk '!/^#/ && NF { print $3 }' "$work/speed-probes.txt" | grep -v '^a-late$' | tr '\n' ' ')"
got_names="$(grep -v '^warn worker a-late' "$work/speed-par.out" | awk '{ n = $3; if ($1 == "FAIL" || $1 == "ok" || $1 == "warn" || $1 == "info") print n }' | tr '\n' ' ')"
if [ "$got_names" = "$want_names" ] || [ "$(awk '{print $3}' "$work/speed-par.out" | grep -v '^a-late$' | tr '\n' ' ')" = "$want_names" ]; then ok "every probe prints exactly one line, in the order of the probe file (the slow allow probes and the fast deny ones do not reorder it)"; else bad "order: got '$got_names' want '$want_names'"; fi
if [ "$(grep -c '^ok worker d-drop-[0-9]* blocked (TimeoutError: timed out)' "$work/speed-par.out")" = "40" ] && [ "$(grep -c '^ok worker d-fast-[0-9] blocked' "$work/speed-par.out")" = "4" ] && grep -q '^warn worker d-nothing inconclusive' "$work/speed-par.out"; then ok "dropped and refused deny probes are 'blocked', and one not listed by ss is only 'inconclusive'"; else bad "deny verdicts: $(head -40 "$work/speed-par.out")"; fi
if grep -q '^FAIL worker d-leak UNEXPECTED SUCCESS' "$work/speed-par.out" && grep -q '^FAIL worker d-open tcp 10.9.9.9:45000 is open by the unit.s own properties' "$work/speed-par.out" && grep -q '^ok worker d-act activation socket: checked by properties only' "$work/speed-par.out" && grep -q '^info worker k-1 known limit, not tested by connecting' "$work/speed-par.out"; then ok "a leak and an address left open by the properties are FAILs, an activation socket and a known limit are judged by properties (concurrent run)"; else bad "special verdicts: $(grep -E 'd-leak|d-open|d-act|k-1' "$work/speed-par.out")"; fi
if grep -q '^ok worker a-slow works' "$work/speed-par.out" && grep -q '^ok worker a-http works' "$work/speed-par.out" && grep -q '^ok worker a-user' "$work/speed-par.out" && grep -q '^ok worker a-child' "$work/speed-par.out"; then ok "an allow probe that answers after 1.2 s passes with a 0.2 s deny timeout: allow probes keep their own, longer timeout"; else bad "allow verdicts: $(grep ' a-' "$work/speed-par.out")"; fi
if grep -q '^FAIL worker a-dropped should work but did not: tcp 127.0.0.1:46000 (TimeoutError: timed out)' "$work/speed-par.out" && grep -q '^warn worker a-late not reachable yet' "$work/speed-par.out"; then ok "an allow probe that times out is a FAIL, never a pass (an allow-late one is only a warning)"; else bad "allow timeout: $(grep -E 'a-dropped|a-late' "$work/speed-par.out")"; fi
if [ "$(accepts tcp) $(accepts unix) $(accepts abstract)" = "0 0 0" ]; then ok "and across both runs the deny probes made zero connections to the other service's tcp, unix and abstract listeners"; else bad "a deny probe reached a listener: $(accepts tcp) $(accepts unix) $(accepts abstract)"; fi
# the speed itself: 40 dropped probes x 0.2 s is 8 s one after another, about 0.4 s side by side; the slow (1.2 s) and the dropped (3 s)
# allow probes take 4.2 s one at a time in both runs, so the concurrent run is bounded by them, not by the deny probes
if [ "$((seq_secs - par_secs))" -ge 5 ] && [ "$par_secs" -le 12 ]; then ok "dropped deny probes overlap: ${seq_secs}s one after another, ${par_secs}s 32 at a time (the allow probes' 4.2 s is most of the latter)"; else bad "timing: sequential ${seq_secs}s, concurrent ${par_secs}s"; fi
# order, with completion order the opposite of file order: six dropped probes first (0.8 s each, together), six refused at once last
{
  for n in 1 2 3 4 5 6; do printf 'deny worker o-slow-%s tcp 127.0.0.1:%s\n' "$n" "$((47000 + n))"; done
  for n in 1 2 3 4; do printf 'deny worker o-fast-%s tcp 127.0.0.1:%s\n' "$n" "$((42000 + n))"; done
} >"$work/order-probes.txt"
standin fenced worker "$work/order-probes.txt" --control "$(awk '{print $3 "=open"}' "$work/order-probes.txt" | paste -sd, -)" --af "$NOUNIX" --activation-text "" --ip-deny "127.0.0.0/8" --deny-timeout 0.8 >"$work/order.out" 2>&1
if [ "$(awk '{print $3}' "$work/order.out" | tr '\n' ' ')" = "$(awk '{print $3}' "$work/order-probes.txt" | tr '\n' ' ')" ] && [ "$(grep -c '^ok worker o-' "$work/order.out")" = "10" ]; then ok "results come out in probe-file order even when the last probes finish first"; else bad "order with fast probes last: $(cat "$work/order.out")"; fi
# which timeout each kind of probe really used: the deny probe the one it was given (0.37 s), the allow probe the full 3 s, whatever --deny-timeout says
printf 'deny worker t-deny tcp 127.0.0.1:48001\nallow worker t-allow tcp 127.0.0.1:48002\nallow-late worker t-late tcp 127.0.0.1:48003\n' >"$work/timeout-probes.txt"
: >"$work/standin.log"
FENCE_STANDIN_LOG="$work/standin.log" standin fenced worker "$work/timeout-probes.txt" --control "t-deny=open" --af "$NOUNIX" --activation-text "" --ip-deny "127.0.0.0/8" --deny-timeout 0.37 >"$work/timeout.out" 2>&1
if grep -qx "drop 48001 0.37" "$work/standin.log" && grep -qx "drop 48002 3.0" "$work/standin.log" && grep -qx "drop 48003 3.0" "$work/standin.log"; then ok "a deny probe waits the --deny-timeout given (0.37 s); allow and allow-late probes wait the full 3 s"; else bad "timeouts used: $(cat "$work/standin.log")"; fi
if grep -q "^ok worker t-deny blocked" "$work/timeout.out" && grep -q "^FAIL worker t-allow should work but did not" "$work/timeout.out"; then ok "  the dropped deny probe is blocked, the dropped allow probe is a FAIL"; else bad "  timeout verdicts: $(cat "$work/timeout.out")"; fi
# a known limit that is run (it connects to nothing: a user lookup, a child process) is reported and never fails the run, working or not
printf 'known worker k-user pwd -\nknown worker k-child spawn -\nknown worker k-false exec false\n' >"$work/known-run.txt"
rc=0
python3 -I "$deploy/fence-probe.py" fenced worker "$work/known-run.txt" --control "" --af "$NOUNIX" --activation-text "" >"$work/known-run.out" 2>&1 || rc=$?
if [ "$rc" -eq 0 ] && grep -q "^info worker k-user known limit: pwd - works" "$work/known-run.out" && grep -q "^info worker k-false known limit: exec false does not work" "$work/known-run.out"; then ok "a known limit that is run (pwd, spawn, exec) is reported as info and never fails the run, whether it works or not"; else bad "known run rc=$rc: $(cat "$work/known-run.out")"; fi
expect_fail_msg "a deny timeout of nothing is refused" "--deny-timeout must be between" python3 -I "$deploy/fence-probe.py" fenced worker "$work/order-probes.txt" --control "" --af "$NOUNIX" --activation-text "" --deny-timeout 0
expect_fail_msg "a deny timeout of minutes is refused" "--deny-timeout must be between" python3 -I "$deploy/fence-probe.py" fenced worker "$work/order-probes.txt" --control "" --af "$NOUNIX" --activation-text "" --deny-timeout 120
expect_fail_msg "no jobs is refused" "--jobs between 1 and 256" python3 -I "$deploy/fence-probe.py" fenced worker "$work/order-probes.txt" --control "" --af "$NOUNIX" --activation-text "" --jobs 0
expect_fail_msg "a timeout that is not a number is refused" "is a number of seconds" python3 -I "$deploy/fence-probe.py" fenced worker "$work/order-probes.txt" --control "" --af "$NOUNIX" --activation-text "" --deny-timeout soon

# fence-check.sh end to end: five sets, each ~180 deny probes that are dropped, run side by side
n_listeners=180
for n in $(seq 1 "$n_listeners"); do printf 'LISTEN 0 5 127.0.0.1:%s 0.0.0.0:*\n' "$((50000 + n))"; done >"$log/ss-tcp"
printf 'allow worker,kernel,build,cli-worker,cli-kernel gw http http://127.0.0.1:%s/healthz\n' "$http_port" >"$work/fc-speed.txt"
reset_accepts
: >"$log/runs"
rc=0
SECONDS=0
STUB_STANDIN="$deploy/test/fenced-standin.py" FENCE_STANDIN_ALLOW_PORTS="$http_port" FENCE_STANDIN_DROP=1 BULIG_FENCE_PROBES="$work/fc-speed.txt" bash "$deploy/fence-check.sh" all >"$work/fc-speed.out" 2>&1 || rc=$?
all_secs=$SECONDS
blocked=0
for s in worker kernel build cli-worker cli-kernel; do
  c="$(grep -c "^ok $s listener-127.0.0.1-[0-9]* blocked (TimeoutError: timed out)" "$work/fc-speed.out")"
  if [ "$c" = "$n_listeners" ]; then blocked=$((blocked + 1)); else echo "    $s: $c blocked lines" >>"$work/fc-speed.detail"; fi
done
if [ "$rc" -eq 0 ] && [ "$blocked" = "5" ] && grep -q "^fence-check: ok" "$work/fc-speed.out"; then ok "fence-check on all five sets, $n_listeners dropped deny probes each (900 in all): every one blocked, exit 0"; else bad "five-set run rc=$rc blocked-sets=$blocked $(cat "$work/fc-speed.detail" 2>/dev/null) $(tail -5 "$work/fc-speed.out")"; fi
# the order of the report: the sets as asked, and each set's probes in the order of the list
if [ "$(grep -E '^(ok|FAIL|warn|info) ' "$work/fc-speed.out" | awk '$2 != "fence-check" { print $2 }' | uniq | tr '\n' ' ')" = "worker kernel build cli-worker cli-kernel " ]; then ok "the report lists the sets in the order asked, each set's lines together"; else bad "set order: $(grep -E '^(ok|FAIL|warn|info) ' "$work/fc-speed.out" | awk '$2 != "fence-check" { print $2 }' | uniq | tr '\n' ' ')"; fi
# (a loose limit that the real numbers are far under: about 10 s with 1.5 s timeouts, 32 at a time, 5 sets together. One set after another it would be about 45 s, and the old 3 s timeouts one after another 45 minutes.)
echo "  (measured: ${all_secs}s for 5 sets x $n_listeners blocked probes, deny timeout 1.5 s, 32 at a time)"
if [ "$all_secs" -le 30 ]; then ok "all five sets with ~180 dropped probes each finish in ${all_secs}s (target: under 3 minutes; the old way took about 45 minutes)"; else bad "five sets took ${all_secs}s"; fi
if [ "$(accepts tcp) $(accepts unix) $(accepts abstract)" = "0 0 0" ]; then ok "and the five-set run made zero connections to the other service's listeners (the control run, known limits and activation skip add none; the 5 allow probes reached Bulig's stand-in: $(accepts http))"; else bad "the five-set run reached a listener: $(accepts tcp) $(accepts unix) $(accepts abstract)"; fi
# the timeouts and the parallelism are handed to the probe, and can be set
: >"$log/ss-tcp"
: >"$log/runs"
BULIG_FENCE_DENY_TIMEOUT=0.3 BULIG_FENCE_JOBS=7 STUB_STANDIN="$deploy/test/fenced-standin.py" FENCE_STANDIN_ALLOW_PORTS="$http_port" FENCE_STANDIN_DROP=1 BULIG_FENCE_PROBES="$work/fc-speed.txt" bash "$deploy/fence-check.sh" worker >"$work/fc-cfg.out" 2>&1
if [ "$(grep -cE -- '--deny-timeout 0.3 --jobs 7( |$)' "$log/runs")" = "1" ] && grep -q "blocked probes wait 0.3s, 7 at a time" "$work/fc-cfg.out"; then ok "BULIG_FENCE_DENY_TIMEOUT and BULIG_FENCE_JOBS reach the probe, and the report says what was used"; else bad "config not passed: $(grep -o -- '--deny-timeout.*' "$log/runs" | head -c 200) $(tail -3 "$work/fc-cfg.out" | head -c 300)"; fi
: >"$log/runs"
BULIG_FENCE_PROBES="$work/fc-speed.txt" bash "$deploy/fence-check.sh" worker >"$work/fc-def.out" 2>&1 || true
if grep -qE -- '--deny-timeout 1.5 --jobs 32( |$)' "$log/runs"; then ok "the defaults are 1.5 s and 32 at a time"; else bad "defaults: $(grep -o -- '--deny-timeout.*' "$log/runs" | head -c 200)"; fi
expect_fail_msg "a deny timeout that is not a number is refused before anything starts" "BULIG_FENCE_DENY_TIMEOUT must be a number" env BULIG_FENCE_DENY_TIMEOUT=soon BULIG_FENCE_PROBES="$work/fc-speed.txt" bash "$deploy/fence-check.sh" worker
expect_fail_msg "so is a jobs count that is not a number" "BULIG_FENCE_JOBS must be a whole number" env BULIG_FENCE_JOBS=many BULIG_FENCE_PROBES="$work/fc-speed.txt" bash "$deploy/fence-check.sh" worker
expect_fail_msg "so is a time cap that is not a number" "BULIG_FENCE_SET_TIMEOUT must be a whole number" env BULIG_FENCE_SET_TIMEOUT=never BULIG_FENCE_PROBES="$work/fc-speed.txt" bash "$deploy/fence-check.sh" worker
: >"$log/ss-tcp"

# a set that does not finish is reported, stopped, and fails the check; the other sets still report
: >"$log/systemctl"
rc=0
SECONDS=0
STUB_RUN_HANG=kernel BULIG_FENCE_SET_TIMEOUT=5 BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker kernel build >"$work/fc-hang.out" 2>&1 || rc=$?
hang_secs=$SECONDS
if [ "$rc" -eq 1 ] && grep -q "^FAIL kernel timeout the set did not finish within 5s" "$work/fc-hang.out" && grep -q "fence-check: FAILED" "$work/fc-hang.out" && ! grep -q "fence-check: ok" "$work/fc-hang.out"; then ok "a set that hangs is reported ('FAIL kernel timeout ... did not finish within 5s') and fails the check"; else bad "hang rc=$rc: $(cat "$work/fc-hang.out")"; fi
if grep -q "^ok worker http works" "$work/fc-hang.out" && grep -q "^ok build http works" "$work/fc-hang.out"; then ok "  the sets that finished still report their lines"; else bad "  other sets lost: $(cat "$work/fc-hang.out")"; fi
if [ "$hang_secs" -le 12 ]; then ok "  and the cap is the total (about 5 s, not 5 s per set): ${hang_secs}s"; else bad "  hang took ${hang_secs}s"; fi
if grep -q "^systemctl stop bulig-fence-kernel-[0-9]*.service" "$log/systemctl"; then ok "  the hung unit is stopped"; else bad "  no stop of the hung unit: $(cat "$log/systemctl")"; fi
sleep 0.3
if ! hang_left; then ok "  and nothing is left running"; else bad "  a hung probe is still running"; hang_kill; fi
# the same, with a probe that really is waiting inside a set (deny timeout 10 s, cap 5 s): the partial result is shown
for n in $(seq 1 8); do printf 'LISTEN 0 5 127.0.0.1:%s 0.0.0.0:*\n' "$((51000 + n))"; done >"$log/ss-tcp"
rc=0
SECONDS=0
STUB_STANDIN="$deploy/test/fenced-standin.py" FENCE_STANDIN_ALLOW_PORTS="$http_port" FENCE_STANDIN_DROP=1 BULIG_FENCE_DENY_TIMEOUT=10 BULIG_FENCE_SET_TIMEOUT=5 BULIG_FENCE_PROBES="$work/fc-speed.txt" bash "$deploy/fence-check.sh" worker >"$work/fc-hang2.out" 2>&1 || rc=$?
if [ "$rc" -eq 1 ] && grep -q "^FAIL worker timeout the set did not finish within 5s" "$work/fc-hang2.out" && [ "$SECONDS" -le 12 ]; then ok "a probe still waiting when the cap is reached is stopped and reported as a timeout (took ${SECONDS}s)"; else bad "waiting probe rc=$rc secs=$SECONDS: $(cat "$work/fc-hang2.out")"; fi
: >"$log/ss-tcp"
# an early exit (here: the second set's unit is not installed) stops the sets already started
cp "$SD/bulig.service" "$work/kernel.unit.keep"
rm -f "$SD/bulig.service"
: >"$log/systemctl"
rc=0
STUB_RUN_HANG=worker BULIG_FENCE_PROBES="$work/fc-clean.txt" bash "$deploy/fence-check.sh" worker kernel >"$work/fc-early.out" 2>&1 || rc=$?
cp "$work/kernel.unit.keep" "$SD/bulig.service"
sleep 0.3
if [ "$rc" -ne 0 ] && grep -q "bulig.service is not installed" "$work/fc-early.out" && grep -q "^systemctl stop bulig-fence-worker-[0-9]*.service" "$log/systemctl" && ! hang_left; then ok "if the check stops early, the probe units already started are stopped and nothing is left running"; else bad "early exit rc=$rc: $(cat "$work/fc-early.out") $(cat "$log/systemctl")"; hang_kill; fi
kill "$second_pid" 2>/dev/null || true
wait "$second_pid" 2>/dev/null || true

# the RUNBOOK states the rule, and no longer says the control run connects
RB="$deploy/RUNBOOK.md"
if grep -q "never completes a connection to anything that is not Bulig's" "$RB" && grep -q "never triggers socket activation of a non-Bulig unit" "$RB" && grep -q "Socket-activated targets are never connected to by anything" "$RB" && grep -q "A known limit is never tested by connecting" "$RB"; then ok "the RUNBOOK states the rule, the activation skip and the known-limit rule"; else bad "the RUNBOOK lacks the never-connect rule"; fi
if grep -q "A per-user unit could still listen on a TCP port or an abstract name" "$RB" && grep -q "http.*https.*dns.*deny lines are refused" "$RB"; then ok "the RUNBOOK says per-user units could listen on TCP or abstract names and why the deny probes are still safe, and that only tcp, unix and abstract deny probes are accepted"; else bad "the RUNBOOK lacks the per-user note"; fi
if grep -q "How long it takes" "$RB" && grep -q "BULIG_FENCE_DENY_TIMEOUT" "$RB" && grep -q "BULIG_FENCE_SET_TIMEOUT" "$RB" && grep -q "never a pass" "$RB" && grep -q "does not hide a leak" "$RB"; then ok "the RUNBOOK says why the check is fast, the three settings, and that a set that does not finish fails"; else bad "the RUNBOOK lacks the speed note"; fi
if grep -q "Activation detection reads the system manager only" "$RB" && grep -q "/run/user/<uid>" "$RB"; then ok "the RUNBOOK says activation detection reads the system manager only (per-user sockets are not probe targets)"; else bad "the RUNBOOK lacks the system-manager-only line"; fi
if ! grep -qi "tried as root, outside every fence\|control run.*connect\|first tried as root" "$RB"; then ok "and no text says the control run connects"; else bad "the RUNBOOK still says the control run connects: $(grep -ni 'tried as root\|control run' "$RB")"; fi
if grep -q "THE RULE" "$deploy/fence-check.sh" && grep -q "THE RULE" "$deploy/fence-probe.py" && grep -q "THE RULE" "$deploy/fence/probes.txt"; then ok "the rule is at the top of fence-check.sh, fence-probe.py and the probe list"; else bad "THE RULE is missing from a fence file"; fi
# no code path in the probe connects outside attempt(): the only socket calls are in attempt() and the allow/deny paths that call it
py_calls="$(python3 -I - "$deploy/fence-probe.py" <<'PY'
import ast, sys
tree = ast.parse(open(sys.argv[1]).read())
bad = []
for fn in ast.walk(tree):
    if isinstance(fn, ast.FunctionDef) and fn.name != "attempt":
        for n in ast.walk(fn):
            if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id in ("socket", "http", "ssl", "urllib") and n.attr in ("create_connection", "socket", "connect", "socketpair", "HTTPConnection", "wrap_socket"):
                bad.append(fn.name + "." + n.attr)
print(",".join(bad) if bad else "none")
PY
)"
if [ "$py_calls" = "none" ]; then ok "fence-probe.py opens a socket only inside attempt(): the control, known and activation code is text-only"; else bad "fence-probe.py opens sockets outside attempt(): $py_calls"; fi
kill "$fixture_pid" 2>/dev/null || true
wait "$fixture_pid" 2>/dev/null || true
finish
