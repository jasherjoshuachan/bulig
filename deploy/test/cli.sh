#!/usr/bin/env bash
# Tests for bulig-cli.sh: one-off commands run as a Bulig user in a capped transient unit, with only that unit's own credentials, and with
# systemd (StateDirectory=) making the user's folder, never root.
# shellcheck disable=SC1091,SC2030,SC2031,SC2154
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

stubs="$work/stubs"
mkdir -p "$stubs"
# the machine's addresses, as `ip -o addr show scope global` prints them on ths-prod-01
cat >"$stubs/ip" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"scope global"*)
    cat <<'DATA'
2: eth0    inet 91.98.153.155/32 metric 100 scope global dynamic eth0
2: eth0    inet6 2a01:4f8:c17:a0b6::1/64 scope global
6: tailscale0    inet 100.85.168.22/32 scope global tailscale0
7: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0
DATA
    ;;
esac
STUB
cat >"$stubs/systemd-run" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$STUB_OUT"
STUB
chmod +x "$stubs/systemd-run" "$stubs/ip"
export PATH="$stubs:/usr/bin:/bin:/usr/sbin:/sbin"
export BULIG_DEPLOY_TEST_ROOT="$work/root" STUB_OUT="$work/argv"
mkdir -p "$work/root/etc/bulig"
for f in config.json pg-url gh-token worker-tokens claude-token worker-token; do : >"$work/root/etc/bulig/$f"; done
cli="$deploy/bulig-cli.sh"
has() { grep -qxF -- "$1" "$work/argv"; }
check() { # check <label> <exact line expected in the systemd-run arguments>
  if has "$2"; then ok "$1"; else bad "$1: '$2' not in: $(tr '\n' ' ' <"$work/argv")"; fi
}
absent() { # absent <label> <pattern that must not appear>
  if grep -qE -- "$2" "$work/argv"; then bad "$1: $(grep -E -- "$2" "$work/argv" | head -2 | tr '\n' ' ')"; else ok "$1"; fi
}

echo "kernel command"
expect_ok "a kernel command runs" bash "$cli" status
check "as user bulig" "--uid=bulig"
check "its folder is made by systemd" "StateDirectory=bulig"
check "private to the user" "StateDirectoryMode=0700"
check "with the kernel's config" "LoadCredential=config:$work/root/etc/bulig/config.json"
check "and database URL" "LoadCredential=pg-url:$work/root/etc/bulig/pg-url"
check "and GitHub token" "LoadCredential=gh-token:$work/root/etc/bulig/gh-token"
check "and worker tokens" "LoadCredential=worker-tokens:$work/root/etc/bulig/worker-tokens"
absent "no Claude token" "claude-token"
absent "no ReadWritePaths (StateDirectory is the writable place)" "ReadWritePaths"
check "capped memory" "MemoryMax=1G"
check "home hidden" "ProtectHome=yes"
check "the kernel's one-off commands cannot reach localhost, private ranges, Tailscale or the docker bridges" "IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7"
check "only the gateway address is let through (no DNS stub, no Tailscale range)" "IPAddressAllow=127.74.3.1/32"
check "the kernel's one-off commands keep AF_UNIX (Postgres)" "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6"
check "and cannot see the tailscale, snapd or docker sockets" "InaccessiblePaths=-/run/tailscale -/run/snapd.socket -/run/docker.sock -/var/run/docker.sock"
check "and resolve names through resolved's upstream list" "BindReadOnlyPaths=/run/systemd/resolve/resolv.conf:/etc/resolv.conf"
check "the CLI is run from the root-owned release" "/opt/bulig/current/packages/cli/bin/bulig.mjs"
if [ "$(tail -1 "$work/argv")" = "status" ]; then ok "the arguments reach the CLI"; else bad "last arg: $(tail -1 "$work/argv")"; fi
check "a pipe for stdin and stdout" "--pipe"

echo "worker command"
expect_ok "a worker command runs" bash "$cli" --as worker --exec git clone https://example.invalid/r /var/lib/bulig-worker/work/r
check "as user bulig-worker" "--uid=bulig-worker"
check "its folder is made by systemd" "StateDirectory=bulig-worker"
check "with the Claude token" "LoadCredential=claude-token:$work/root/etc/bulig/claude-token"
check "and its own worker token" "LoadCredential=worker-token:$work/root/etc/bulig/worker-token"
absent "none of the kernel's secrets or its config" "pg-url|gh-token|worker-tokens|config.json"
absent "no ReadWritePaths" "ReadWritePaths"
check "the worker's one-off commands cannot reach Tailscale or this machine's own public addresses" "IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7 2a01:4f8:c17:a0b6::1/128 91.98.153.155/32"
check "only the gateway address is let through" "IPAddressAllow=127.74.3.1/32"
check "the worker's one-off commands have no unix sockets at all" "RestrictAddressFamilies=AF_INET AF_INET6"
if [ "$(grep -c '^RestrictAddressFamilies=' "$work/argv")" = "1" ] && ! grep -q 'RestrictAddressFamilies=.*AF_UNIX' "$work/argv"; then ok "and nothing else in the command line gives AF_UNIX back"; else bad "address-family lines: $(grep Restrict "$work/argv")"; fi
check "and cannot see the tailscale, snapd or docker sockets" "InaccessiblePaths=-/run/tailscale -/run/snapd.socket -/run/docker.sock -/var/run/docker.sock"
check "and resolve names through resolved's upstream list" "BindReadOnlyPaths=/run/systemd/resolve/resolv.conf:/etc/resolv.conf"
if [ "$(tail -4 "$work/argv" | tr '\n' ' ')" = "git clone https://example.invalid/r /var/lib/bulig-worker/work/r " ]; then ok "--exec runs the program as given"; else bad "tail: $(tail -4 "$work/argv" | tr '\n' ' ')"; fi
absent "--exec does not run the bulig CLI" "bulig.mjs"

echo "a credential that does not exist yet"
rm "$work/root/etc/bulig/claude-token"
expect_ok "the Claude token's own setup can run before the token exists" bash "$cli" --as worker --exec claude setup-token
absent "the missing credential is left out" "claude-token"
check "the other one is still loaded" "LoadCredential=worker-token:$work/root/etc/bulig/worker-token"
if grep -q "claude-token does not exist" "$work/out"; then ok "and a note says so"; else bad "no note: $(cat "$work/out")"; fi
check "an --exec command starts in / (the release may not exist yet)" "--working-directory=/"
: >"$work/root/etc/bulig/claude-token"

echo "terminal and refusals"
expect_ok "a terminal command runs" bash "$cli" --as worker --tty --exec claude setup-token
check "--tty gives a pseudo-terminal" "--pty"
absent "and no pipe" "^--pipe$"
expect_fail_msg "an unknown role is refused" "--as must be kernel or worker" bash "$cli" --as root status
expect_fail_msg "no command is refused" "usage: bulig-cli.sh" bash "$cli"

finish
