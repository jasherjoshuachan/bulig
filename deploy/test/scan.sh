#!/usr/bin/env bash
# Tests for the built-in checks of scripts/scan-forbidden.sh: no real host detail in this public repository. The offending text is built from
# pieces at run time, so this file does not contain it (the scan would refuse it).
# shellcheck disable=SC1091,SC2030,SC2031,SC2154
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
scan="$deploy/../scripts/scan-forbidden.sh"
[ -f "$scan" ] || { echo "no scan script at $scan"; exit 1; }

mkrepo() { # mkrepo <dir>: a tiny git repo with one clean file
  rm -rf "$1"
  mkdir -p "$1"
  git -C "$1" init -q
  git -C "$1" config user.email t@example.invalid
  git -C "$1" config user.name t
  printf 'listen 127.74.3.1:7431 and 127.0.0.1, 0.0.0.0, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 192.0.2.7, 198.51.100.7, 203.0.113.10, 2001:db8::10, version 1.2.3, mask 255.255.255.0\n' >"$1/clean.txt"
  git -C "$1" add clean.txt
}
run_scan() { env -u BULIG_FORBIDDEN_TERMS XDG_CONFIG_HOME="$work/none" SCAN_ROOT="$1" bash "$scan"; }

echo "scan-forbidden.sh built-in checks"
repo="$work/repo"
mkrepo "$repo"
expect_ok "allowed addresses (loopback, the gateway, private, tailscale, documentation) pass" run_scan "$repo"
expect_ok "the real tree passes" env -u BULIG_FORBIDDEN_TERMS XDG_CONFIG_HOME="$work/none" bash "$scan"

offends() { # offends <label> <rule it must name> <the text>
  mkrepo "$repo"
  printf 'line one\n%s\n' "$3" >"$repo/bad.txt"
  git -C "$repo" add bad.txt
  run_scan "$repo" >"$work/scan.out" 2>&1
  rc=$?
  if [ "$rc" -ne 0 ] && grep -q "bad.txt:2 ($2)" "$work/scan.out"; then ok "caught: $1"; else bad "not caught: $1 (rc=$rc): $(cat "$work/scan.out")"; fi
  # the output names the file, the line and the rule, never the text
  if [ -n "$4" ] && grep -qF -- "$4" "$work/scan.out"; then bad "  the scan printed the matched text for: $1"; else ok "  and it did not print the matched text"; fi
}
pub4="$((4 * 2)).$((4 * 2)).$((4 * 2)).$((4 * 2))"
offends "a public IPv4 address" ipv4-outside-allowed-ranges "ssh $pub4" "$pub4"
offends "an address just below the Tailscale range" ipv4-outside-allowed-ranges "peer 100.$((64 - 1)).0.1" "100.63"
offends "an address just above the Tailscale range" ipv4-outside-allowed-ranges "peer 100.$((127 + 1)).0.1" "100.128"
offends "172.32 (just outside 172.16/12)" ipv4-outside-allowed-ranges "bridge 172.$((31 + 1)).0.1" "172.32"
mkrepo "$repo"
printf 'deny 169.254.0.0/16 224.0.0.0/4\n' >"$repo/ranges.txt"
git -C "$repo" add ranges.txt
expect_ok "the link-local and multicast range bases written as prefixes pass" run_scan "$repo"
llb="169.$((250 + 4)).0.0"
offends "the link-local base without a prefix is still an address" ipv4-outside-allowed-ranges "x $llb y" "$llb"
offends "a link-local IPv4 address" ipv4-outside-allowed-ranges "x 169.$((250 + 4)).1.1" "169.254"
g6="26""06:47""00::11""11"
offends "a global IPv6 address" ipv6-global-address "v6 $g6" "$g6"
g2="20""01:48""60::88""88"
offends "a global IPv6 address that also starts with 2001" ipv6-global-address "v6 $g2" "$g2"
g3="3""fff:1::1"
offends "a global IPv6 address with a 3 prefix" ipv6-global-address "v6 $g3" "$g3"
p1="92""22"
offends "the first port number" "port-1" "127.0.0.1:$p1" "$p1"
offends "another port number" "port-2" "port $((82 * 100 + 33))" ""
offends "another port number (2)" "port-3" "port $((72 * 100 + 33))" ""
offends "another port number (3)" "port-4" "port $((114 * 100 + 34))" ""
x1="X1""1-unix"
offends "the X socket folder" x-display "/tmp/.$x1/foo" "$x1"
offends "an X display name" x-display "display X$((90 + 9))" ""
offends "an X server flag" x-server-flag "someserver :1 -$(printf 'a')c" ""
mk="scan-forbidden: ""allow-addresses"
mkrepo "$repo"
printf '%s\n' "refuse $pub4 and peer 100.$((64 - 1)).0.1 and v6 $g6 // $mk" >"$repo/marked.txt"
git -C "$repo" add marked.txt
expect_ok "a line marked allow-addresses may name addresses outside the allowed ranges" run_scan "$repo"
offends "the marker does not excuse a port number" "port-1" "127.0.0.1:$p1 // $mk" "$p1"
offends "the marker does not excuse an X display name" x-display "display X$((90 + 9)) // $mk" ""
mkrepo "$repo"
printf '%s\nssh %s\n' "// $mk" "$pub4" >"$repo/bad.txt"
git -C "$repo" add bad.txt
run_scan "$repo" >"$work/scan.out" 2>&1
rc=$?
if [ "$rc" -ne 0 ] && grep -q "bad.txt:2 (ipv4-outside-allowed-ranges)" "$work/scan.out"; then ok "a marker on another line excuses nothing"; else bad "a marker on line 1 excused line 2 (rc=$rc)"; fi
mkrepo "$repo"
printf 'tar -xzf x; has-ac-in-a-word; 22922 is fine; 1.2.3.4.5; 300.1.1.1\n' >"$repo/ok2.txt"
git -C "$repo" add ok2.txt
expect_ok "near misses pass (a word with ac in it, a longer number, a five-part version, an octet over 255)" run_scan "$repo"

# A checker that crashes must fail the scan, never pass it (found 20 Oct 2026: a quoting slip crashed it and it said clean).
broken="$work/scan-broken.sh"
sed 's/^import re, sys$/import re, sys; raise SystemExit(3)/' "$scan" >"$broken"
mkrepo "$repo"
if env -u BULIG_FORBIDDEN_TERMS XDG_CONFIG_HOME="$work/none" SCAN_ROOT="$repo" bash "$broken" >"$work/scan.out" 2>&1; then bad "a scan whose checker crashes passed"; elif grep -q "did not run" "$work/scan.out"; then ok "a scan whose checker crashes fails, and says so"; else bad "a crashed checker failed without saying why: $(cat "$work/scan.out")"; fi

echo "the old text, put back into the real tree"
real="$work/real-copy"
rm -rf "$real"
mkdir -p "$real"
(cd "$deploy/.." && git ls-files -z | xargs -0 -I{} cp --parents {} "$real/" 2>/dev/null) || (cd "$deploy/.." && tar -c --exclude=node_modules --exclude=.git -f - . | tar -x -C "$real")
git -C "$real" init -q 2>/dev/null
git -C "$real" config user.email t@example.invalid
git -C "$real" config user.name t
git -C "$real" add -A >/dev/null 2>&1
expect_ok "a copy of the real tree is clean" run_scan "$real"
oldline="deny  worker,kernel,build,cli-worker,cli-kernel  service-$p1       tcp       127.0.0.1:$p1"
printf '%s\n' "$oldline" >>"$real/deploy/fence/probes.txt"
git -C "$real" add -A >/dev/null 2>&1
run_scan "$real" >"$work/scan.out" 2>&1
rc=$?
if [ "$rc" -ne 0 ] && grep -q "deploy/fence/probes.txt:.* (port-1)" "$work/scan.out"; then ok "one old probe line put back into deploy/fence/probes.txt makes the scan fail"; else bad "old line not caught (rc=$rc): $(cat "$work/scan.out")"; fi
git -C "$real" checkout -q -- . 2>/dev/null || true
oldaddr="inet $((90 + 1)).$((98)).$((153)).$((155))"
printf '%s\n' "$oldaddr" >>"$real/deploy/test/cli.sh"
git -C "$real" add -A >/dev/null 2>&1
rc=0
run_scan "$real" >"$work/scan.out" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && grep -q "deploy/test/cli.sh:.* (ipv4-outside-allowed-ranges)" "$work/scan.out"; then ok "an old host address put back into a test makes the scan fail"; else bad "old address not caught: $(cat "$work/scan.out")"; fi

finish
