#!/usr/bin/env bash
# Tests on the unit files as text: the claims in ADR 0011 and the RUNBOOK about what each unit holds, caps and hardening, so a later edit
# cannot quietly change one. (systemd-analyze verify checks the syntax; the PR body records that run.)
# shellcheck disable=SC1091,SC2030,SC2031,SC2154
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
sd="$deploy/systemd"

# value <unit> <Key>: every value of that key, one per line
value() { grep -E "^$2=" "$sd/$1" | sed -E "s/^$2=//"; }
has() { [ -n "$(value "$1" "$2")" ]; }
want() { # want <unit> <Key> <exact value>
  if [ "$(value "$1" "$2")" = "$3" ]; then ok "$1: $2=$3"; else bad "$1: $2 is '$(value "$1" "$2")', wanted '$3'"; fi
}

echo "the two Bulig units"
for u in bulig.service bulig-worker.service; do
  name="${u%.service}"
  want "$u" User "$name"
  want "$u" Group "$name"
  want "$u" StateDirectory "$name"
  want "$u" StateDirectoryMode 0700
  want "$u" UMask 0077
  want "$u" NoNewPrivileges true
  want "$u" ProtectSystem strict
  want "$u" ProtectHome yes
  want "$u" PrivateTmp true
  want "$u" CapabilityBoundingSet ""
  want "$u" KillMode control-group
  for k in ProtectKernelTunables ProtectKernelModules ProtectKernelLogs ProtectControlGroups RestrictSUIDSGID LockPersonality PrivateDevices; do
    want "$u" "$k" true
  done
  if value "$u" ExecStart | grep -q '^/usr/bin/node /opt/bulig/current/'; then ok "$u: runs code from the root-owned /opt/bulig/current"; else bad "$u ExecStart: $(value "$u" ExecStart)"; fi
  if has "$u" ReadWritePaths; then bad "$u has ReadWritePaths= (StateDirectory is the only writable place): $(value "$u" ReadWritePaths)"; else ok "$u: no ReadWritePaths (the StateDirectory is the one writable place)"; fi
  if has "$u" ExecStartPre || has "$u" ExecStartPost || has "$u" PermissionsStartOnly; then bad "$u runs a helper around ExecStart"; else ok "$u: no helper steps around ExecStart"; fi
done

echo "credentials: each unit holds only its own"
kernel_creds="$(value bulig.service LoadCredential | sort | tr '\n' ' ')"
worker_creds="$(value bulig-worker.service LoadCredential | sort | tr '\n' ' ')"
if [ "$kernel_creds" = "config:/etc/bulig/config.json gh-token:/etc/bulig/gh-token pg-url:/etc/bulig/pg-url worker-tokens:/etc/bulig/worker-tokens " ]; then ok "the kernel holds config, pg-url, gh-token and worker-tokens"; else bad "kernel credentials: $kernel_creds"; fi
if [ "$worker_creds" = "claude-token:/etc/bulig/claude-token github-read-token:/etc/bulig/github-read-token worker-token:/etc/bulig/worker-token " ]; then ok "the worker holds claude-token, github-read-token and worker-token only"; else bad "worker credentials: $worker_creds"; fi
if value bulig.service LoadCredential | grep -q claude; then bad "the kernel unit holds the Claude token"; else ok "the kernel unit never holds the Claude token"; fi
if value bulig.service LoadCredential | grep -q 'github-read-token'; then bad "the kernel unit holds the worker's read-only GitHub token"; else ok "the kernel unit never holds the worker's read-only GitHub token"; fi
if value bulig-worker.service LoadCredential | grep -q 'gh-token'; then bad "the worker unit holds the kernel's GitHub token (the one that can push)"; else ok "the worker unit never holds the kernel's gh-token"; fi
if value bulig-worker.service LoadCredential | grep -qE 'pg-url|gh-token|config|worker-tokens'; then bad "the worker unit holds a kernel secret or the config"; else ok "the worker unit holds no kernel secret and no config"; fi
if [ "$(value bulig.service Environment | tr '\n' ' ')" = "HOME=/var/lib/bulig PATH=/usr/local/bin:/usr/bin:/bin " ]; then ok "the kernel's environment is only HOME and PATH (no secret in it)"; else bad "kernel environment: $(value bulig.service Environment)"; fi

echo "network and sockets: what each unit can reach"
DENY="127.0.0.0/8 ::1/128 169.254.0.0/16 fe80::/10 224.0.0.0/4 ff00::/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7"
INACC="-/run/tailscale -/run/snapd.socket -/run/docker.sock -/var/run/docker.sock"
RES="/run/systemd/resolve/resolv.conf:/etc/resolv.conf"
# the worker: no unix socket of any kind, the gateway address and nothing else local
want bulig-worker.service RestrictAddressFamilies "AF_INET AF_INET6"
want bulig-worker.service IPAddressDeny "$DENY"
want bulig-worker.service IPAddressAllow "127.74.3.1/32"
want bulig-worker.service InaccessiblePaths "$INACC"
want bulig-worker.service BindReadOnlyPaths "$RES"
# the kernel: keeps AF_UNIX for Postgres, the gateway address only; a Mac worker's /32 comes from a drop-in, none by default
want bulig.service RestrictAddressFamilies "AF_UNIX AF_INET AF_INET6"
want bulig.service IPAddressDeny "$DENY"
want bulig.service IPAddressAllow "127.74.3.1/32"
want bulig.service InaccessiblePaths "$INACC"
want bulig.service BindReadOnlyPaths "$RES"
# backup and drill: private ranges denied, nothing allowed, upstream resolvers, docker's config in a root-owned folder
for u in bulig-backup.service bulig-restore-drill.service; do
  want "$u" IPAddressDeny "$DENY"
  if has "$u" IPAddressAllow; then bad "$u allows an address: $(value "$u" IPAddressAllow)"; else ok "$u allows no address at all"; fi
  want "$u" BindReadOnlyPaths "$RES"
  want "$u" Environment "DOCKER_CONFIG=/var/lib/bulig-checks/docker"
done
want bulig-loopback.service IPAddressDeny any
for u in bulig.service bulig-worker.service bulig-backup.service bulig-restore-drill.service bulig-loopback.service; do
  if [ "$(value "$u" IPAddressDeny | wc -l | tr -d ' ')" = "1" ]; then ok "$u has an IPAddressDeny line"; else bad "$u has no (or two) IPAddressDeny lines"; fi
  case " $(value "$u" IPAddressAllow) " in
    *" 127.0.0.1/32 "* | *" 127.0.0.0/8 "* | *" localhost "* | *" any "* | *" 0.0.0.0/0 "* | *" 172.16.0.1/32 "* | *" ::1/128 "* | *" 127.0.0.53/32 "* | *" 100.64.0.0/10 "*) bad "$u allows localhost, the DNS stub, a whole range, the docker bridge or everything: $(value "$u" IPAddressAllow)" ;;
    *) ok "$u does not allow 127.0.0.1, localhost, the DNS stub, Tailscale as a range, the docker bridge or everything" ;;
  esac
done
# systemd-run refuses a symbolic name (localhost, link-local, multicast, any) inside a list, and the fence check copies
# unit values into systemd-run, so no IP list anywhere in the kit may use one (found on the server, 20 Oct 2026).
sym_hits="$(grep -nE '^(IPAddressDeny|IPAddressAllow)=.*\b(localhost|link-local|multicast)\b' "$sd"/*.service 2>/dev/null; grep -nE 'BULIG_IP_DENY_PRIVATE=.*\b(localhost|link-local|multicast)\b' "$deploy/lib/common.sh")"
if [ -z "$sym_hits" ]; then ok "no IP list in the units or lib/common.sh uses a symbolic name (systemd-run cannot parse one in a list)"; else bad "a symbolic name in an IP list: $sym_hits"; fi
for u in bulig.service bulig-worker.service; do
  if [ "$(value "$u" LimitCORE)" = "0" ]; then ok "$u writes no core dump (LimitCORE=0)"; else bad "$u can write a core dump holding a credential"; fi
done
for u in bulig.service bulig-worker.service bulig-backup.service bulig-restore-drill.service; do
  missing=""
  for t in 127.0.0.0/8 ::1/128 169.254.0.0/16 fe80::/10 224.0.0.0/4 ff00::/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7; do
    case " $(value "$u" IPAddressDeny) " in *" $t "*) ;; *) missing="$missing $t" ;; esac
  done
  if [ -z "$missing" ]; then ok "$u denies localhost, link-local, multicast, 10/8, 172.16/12, 192.168/16, 100.64/10 and fc00::/7"; else bad "$u does not deny:$missing"; fi
  if grep -qE '127\.0\.0\.53' <(grep -v '^#' "$sd/$u"); then bad "$u names the DNS stub 127.0.0.53 in a setting"; else ok "$u does not name the DNS stub (DNS goes through resolved's upstream list)"; fi
done
# Only the loopback unit, which uses netlink to add an address, may have anything but IP families; neither the worker nor the build may have unix sockets.
case " $(value bulig-worker.service RestrictAddressFamilies) " in *AF_UNIX* | *AF_NETLINK* | *AF_PACKET*) bad "the worker unit allows a non-IP socket family" ;; *) ok "the worker unit allows IP sockets only (no AF_UNIX, no AF_NETLINK)" ;; esac
case " $(value bulig.service RestrictAddressFamilies) " in *AF_UNIX*) ok "the kernel keeps AF_UNIX (its Postgres socket): a documented limit, see the RUNBOOK" ;; *) bad "the kernel unit lost AF_UNIX, so it cannot reach Postgres" ;; esac
if grep -q '^## Known limits' "$deploy/RUNBOOK.md" && sed -n '/^## Known limits/,/^## Must be proven/p' "$deploy/RUNBOOK.md" | grep -q 'deny unix addr=@\*\*' && sed -n '/^## Known limits/,/^## Must be proven/p' "$deploy/RUNBOOK.md" | grep -qi 'abstract'; then ok "the RUNBOOK's Known limits name the kernel's abstract-socket reach and the AppArmor next step"; else bad "RUNBOOK Known limits section is missing the abstract-socket limit"; fi
# a wording check: no file claims the allowed addresses are limited to a port
if grep -rniE 'only (the )?(dns|port 53)|answers dns and nothing else|dns and nothing else' "$sd" "$deploy/RUNBOOK.md" >/dev/null; then bad "a file still claims an allowed address is DNS-only: $(grep -rniE 'dns and nothing else|only dns' "$sd" "$deploy/RUNBOOK.md" | head -2)"; else ok "no file claims an allowed address reaches only DNS or only one port"; fi
for u in bulig-worker.service bulig.service; do
  if grep -q 'ADDRESSES, NOT PORTS' "$sd/$u"; then ok "$u says the filter matches addresses and not ports"; else bad "$u does not say the filter matches addresses, not ports"; fi
done

for u in bulig.service bulig-worker.service bulig-backup.service bulig-restore-drill.service; do
  case " $(value "$u" After) " in *" systemd-resolved.service "*) ok "$u starts after systemd-resolved.service (the resolver list it binds must exist)" ;; *) bad "$u does not start After=systemd-resolved.service" ;; esac
  case " $(value "$u" Wants) " in *" systemd-resolved.service "*) ok "$u wants systemd-resolved.service" ;; *) bad "$u does not want systemd-resolved.service" ;; esac
done
if grep -q 'restart the Bulig units' "$deploy/RUNBOOK.md" && grep -q 'upstream DNS servers change' "$deploy/RUNBOOK.md"; then ok "the RUNBOOK says to restart the units when the upstream DNS changes"; else bad "RUNBOOK: no restart-on-DNS-change note"; fi
if grep -q 'user lookup' "$deploy/fence/probes.txt" || grep -q 'dynamic' "$deploy/fence/probes.txt"; then ok "the probe file explains the build's user-lookup limit"; else bad "no explanation of the build's user-lookup limit"; fi
if grep -q 'DynamicUser' "$deploy/RUNBOOK.md" && grep -q 'io.systemd.DynamicUser' "$deploy/RUNBOOK.md" && grep -q 'node-homedir' "$deploy/RUNBOOK.md"; then ok "the RUNBOOK explains why the build's lookup fails, and that it does not need it"; else bad "RUNBOOK: build user-lookup explanation missing"; fi

if grep -q '^## Must be proven on the server first' "$deploy/RUNBOOK.md" && sed -n '/^## Must be proven on the server first/,/^## Things to know/p' "$deploy/RUNBOOK.md" | grep -q 'systemctl show' && sed -n '/^## Must be proven on the server first/,/^## Things to know/p' "$deploy/RUNBOOK.md" | grep -q 'resolv.conf'; then ok "the RUNBOOK lists what must be proven on the server first"; else bad "RUNBOOK: no 'Must be proven on the server first' list"; fi

PROVEN="$(sed -n '/^## Must be proven on the server first/,/^## Things to know/p' "$deploy/RUNBOOK.md")"
if grep -q 'fence-extra-probes.txt' <<<"$PROVEN" && grep -q 'gh-token' <<<"$PROVEN"; then ok "the server-first list names the extra probes file and the gh-token credential"; else bad "server-first list lacks the extra probes or the gh-token item"; fi
CUT="$(sed -n '/^## Cutover/,/^## Rollback/p' "$deploy/RUNBOOK.md")"
if grep -q 'every item in "Must be proven on the server first"' <<<"$CUT" && grep -q 'postcheck.sh' <<<"$CUT"; then ok "Cutover waits for every server-first item, health.sh and postcheck.sh"; else bad "Cutover does not say it waits for the server-first list, health.sh and postcheck.sh"; fi
STEP8="$(sed -n '/^8\. \*\*Copy over the old record/,/^9\. \*\*Synthetic/p' "$deploy/RUNBOOK.md")"
# shellcheck disable=SC2016
if grep -q 'bulig-cli.sh --as kernel --exec' <<<"$STEP8" && grep -q 'Never `scp`' <<<"$STEP8"; then ok "step 8 pipes the SQLite file in through bulig-cli.sh --exec and says never to scp it into a user's folder"; else bad "step 8 does not use bulig-cli.sh --exec"; fi
UNINST="$(grep -- '- \*\*Remove Bulig completely' "$deploy/RUNBOOK.md")"
if [ "${UNINST%%postcheck.sh*}" != "$UNINST" ] && [ "${UNINST%%postcheck.sh*}" != "${UNINST%%/var/lib/bulig-checks*}" ] && [ "${#UNINST}" -gt 0 ]; then
  before_pc="${UNINST%%\`postcheck.sh\`*}"
  case "$before_pc" in *"/var/lib/bulig-checks"*) bad "uninstall removes /var/lib/bulig-checks before postcheck.sh runs" ;; *) ok "uninstall runs postcheck.sh before the folder it reads is removed" ;; esac
else bad "uninstall text: postcheck order not found"; fi
if grep -q 'ProtectKernelTunables' <(grep -n 'unpacks the tar as root' "$deploy/RUNBOOK.md") && grep -q 'ProtectClock' <(grep -n 'unpacks the tar as root' "$deploy/RUNBOOK.md"); then ok "the RUNBOOK's claim about the unpack sandbox lists the kernel protections it really has"; else bad "RUNBOOK unpack claim"; fi
if grep -q 'Depends on PR #50' "$deploy/RUNBOOK.md"; then ok "the RUNBOOK names its dependency on PR #50 (config credential, gh-token, gateway)"; else bad "no PR #50 dependency note"; fi
if grep -q 'loopback address, so it may treat it as local and trusted' "$deploy/RUNBOOK.md" && ! grep -q 'public anyway' <(grep -v 'not "public anyway"' "$deploy/RUNBOOK.md"); then ok "the RUNBOOK says requests from the gateway address reach wildcard listeners with a loopback source (not 'public anyway')"; else bad "RUNBOOK wildcard-listener wording"; fi

echo "the gateway address"
gw="127.74.3.1"
case "$(value bulig-worker.service ExecStart)" in *"--kernel http://$gw:7431 "*) ok "the worker connects to http://$gw:7431" ;; *) bad "worker URL: $(value bulig-worker.service ExecStart)" ;; esac
if [ "$(value bulig-loopback.service ExecStart)" = "/usr/bin/ip address replace $gw/32 dev lo" ] && [ "$(value bulig-loopback.service ExecStop)" = "/usr/bin/ip address del $gw/32 dev lo" ]; then ok "bulig-loopback.service puts $gw/32 on lo and takes it off again"; else bad "loopback exec: $(value bulig-loopback.service ExecStart) / $(value bulig-loopback.service ExecStop)"; fi
want bulig-loopback.service Type oneshot
want bulig-loopback.service RemainAfterExit yes
want bulig-loopback.service Before "bulig.service bulig-worker.service"
want bulig-loopback.service CapabilityBoundingSet CAP_NET_ADMIN
want bulig-loopback.service RestrictAddressFamilies "AF_NETLINK AF_UNIX"
want bulig.service Requires bulig-loopback.service
if value bulig-worker.service Wants | grep -q bulig-loopback.service && value bulig-worker.service After | grep -q bulig-loopback.service; then ok "the worker wants and starts after the gateway address"; else bad "worker ordering"; fi
if value bulig.service After | grep -q bulig-loopback.service; then ok "the kernel starts after the gateway address"; else bad "kernel ordering"; fi

echo "caps (ADR 0011)"
want bulig.service MemoryMax 1G
want bulig.service CPUQuota 100%
want bulig.service TasksMax 256
want bulig-worker.service MemoryMax 3G
want bulig-worker.service CPUQuota 250%
want bulig-worker.service TasksMax 512

echo "the worker's command line against the CLI in PR #50"
cmdline="$(value bulig-worker.service ExecStart)"
flags="$(grep -oE ' --[a-z-]+' <<<"$cmdline" | tr -d ' ' | sort | tr '\n' ' ')"
if [ "$flags" = "--claude-token-file --id --kernel --slots --token-file --work-dir " ]; then ok "ExecStart uses --kernel --id --token-file --claude-token-file --work-dir --slots, all flags of bulig worker"; else bad "worker flags: $flags"; fi
case "$cmdline" in *"--token-file %d/worker-token"*"--claude-token-file %d/claude-token"*) ok "both token files are read from the unit's credentials directory (%d)" ;; *) bad "token file flags: $cmdline" ;; esac
# shellcheck disable=SC2016
case "$cmdline" in *'$BULIG_WORKER_REPOS') ok "the repositories come from BULIG_WORKER_REPOS (worker.env)" ;; *) bad "repos: $cmdline" ;; esac
want bulig-worker.service EnvironmentFile /etc/bulig/worker.env
case "$cmdline" in *"--work-dir %S/bulig-worker/work"*) ok "stage folders are under the worker's own StateDirectory" ;; *) bad "work dir: $cmdline" ;; esac
kcmd="$(value bulig.service ExecStart)"
case "$kcmd" in */bulig.mjs\ serve) ok "the kernel runs: bulig serve (no config path flag: it reads \$CREDENTIALS_DIRECTORY/config first, PR #50)" ;; *) bad "kernel command: $kcmd" ;; esac

echo "the root units (backup and drill)"
for u in bulig-backup.service bulig-restore-drill.service; do
  want "$u" User root
  if value "$u" ExecStart | grep -q '^/usr/local/lib/bulig/current/'; then ok "$u runs from the root-owned /usr/local/lib/bulig/current"; else bad "$u ExecStart: $(value "$u" ExecStart)"; fi
  if value "$u" ReadWritePaths | grep -q 'bulig-worker\|/var/lib/bulig '; then bad "$u can write a user's folder"; else ok "$u: writable paths are root's only ($(value "$u" ReadWritePaths))"; fi
done

echo "the config template"
cfg="$deploy/bulig.config.vps.json"
if python3 -I -c "
import json,sys
c=json.load(open(sys.argv[1]))
assert c['store']['kind']=='postgres' and c['store']['urlCredential']=='pg-url', 'store'
assert 'channel-telegram' not in c['enabled'], 'telegram must stay off until cutover'
assert 'worker-claude-code' not in c['enabled'], 'the kernel runs no Claude'
assert 'worker-gateway' in c['enabled']
w=c['pluginConfig']['worker-gateway']
assert w['listen']==['127.74.3.1'] and w['port']==7431 and w['workers']['vps']['credential']=='worker-tokens'
assert c['pluginConfig']['gate-evidence']['mode']=='warn' and c['pluginConfig']['gate-promise']['mode']=='warn'
assert c['dbPath'].startswith('/var/lib/bulig/'), 'dbPath'
" "$cfg" 2>"$work/err"; then ok "the template: Postgres from the pg-url credential, gateway on 127.74.3.1:7431 for worker vps, gates in warn, Telegram and the local worker off"; else bad "config template: $(cat "$work/err")"; fi

finish
