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
  for k in ProtectKernelModules ProtectControlGroups ProtectClock RestrictSUIDSGID LockPersonality PrivateDevices; do
    want "$u" "$k" true
  done
  want "$u" ProtectProc invisible
  if value "$u" ExecStart | grep -q '^/usr/bin/node /opt/bulig/current/'; then ok "$u: runs code from the root-owned /opt/bulig/current"; else bad "$u ExecStart: $(value "$u" ExecStart)"; fi
  if has "$u" ReadWritePaths; then bad "$u has ReadWritePaths= (StateDirectory is the only writable place): $(value "$u" ReadWritePaths)"; else ok "$u: no ReadWritePaths (the StateDirectory is the one writable place)"; fi
  if has "$u" ExecStartPre || has "$u" ExecStartPost || has "$u" PermissionsStartOnly; then bad "$u runs a helper around ExecStart"; else ok "$u: no helper steps around ExecStart"; fi
done

echo "the kernel keeps every /proc protection"
for k in ProtectKernelTunables ProtectKernelLogs ProtectHostname; do want bulig.service "$k" true; done

echo "the worker's hardening: the set proven with Claude Code's Bash sandbox on the server (21 Oct 2026)"
# bwrap mounts a fresh /proc for every sandboxed command, and the kernel refuses it when part of the unit's /proc is mounted over: these four
# must never come back on the worker (each one broke `--proc /proc` on the server).
for k in ProtectKernelTunables ProtectKernelLogs ProtectHostname ProcSubset; do
  if has bulig-worker.service "$k"; then bad "bulig-worker.service sets $k=$(value bulig-worker.service "$k") (bwrap cannot mount /proc then)"; else ok "bulig-worker.service does not set $k (bwrap needs a /proc it can mount)"; fi
done
# what stands in for them, and the rest of the proven set
want bulig-worker.service ReadOnlyPaths "/sys"
want bulig-worker.service SystemCallFilter "~syslog sethostname setdomainname"
want bulig-worker.service ProtectClock true
want bulig-worker.service ProtectProc invisible
WSVC0="$(cat "$sd/bulig-worker.service")"
if grep -q 'ProtectKernelTunables -> ReadOnlyPaths=/sys' <<<"$WSVC0" && grep -q 'ProtectKernelLogs -> SystemCallFilter=~syslog' <<<"$WSVC0" && grep -q 'ProtectHostname -> SystemCallFilter=~sethostname setdomainname' <<<"$WSVC0" && grep -q "Can't mount proc on /newroot/proc" <<<"$WSVC0"; then ok "the worker unit says what each removed protection was swapped for, and why (the bwrap error)"; else bad "the worker unit does not explain the /proc swaps"; fi

echo "credentials: each unit holds only its own"
kernel_creds="$(value bulig.service LoadCredential | sort | tr '\n' ' ')"
worker_creds="$(value bulig-worker.service LoadCredential | sort | tr '\n' ' ')"
if [ "$kernel_creds" = "config:/etc/bulig/config.json gh-token:/etc/bulig/gh-token pg-url:/etc/bulig/pg-url telegram-token:/etc/bulig/telegram-token worker-tokens:/etc/bulig/worker-tokens " ]; then ok "the kernel holds config, pg-url, gh-token, telegram-token and worker-tokens"; else bad "kernel credentials: $kernel_creds"; fi
if [ "$worker_creds" = "claude-token:/etc/bulig/claude-token github-read-token:/etc/bulig/github-read-token worker-token:/etc/bulig/worker-token " ]; then ok "the worker holds claude-token, github-read-token and worker-token only"; else bad "worker credentials: $worker_creds"; fi
if value bulig.service LoadCredential | grep -q claude; then bad "the kernel unit holds the Claude token"; else ok "the kernel unit never holds the Claude token"; fi
if value bulig.service LoadCredential | grep -q 'github-read-token'; then bad "the kernel unit holds the worker's read-only GitHub token"; else ok "the kernel unit never holds the worker's read-only GitHub token"; fi
if value bulig-worker.service LoadCredential | grep -q 'gh-token'; then bad "the worker unit holds the kernel's GitHub token (the one that can push)"; else ok "the worker unit never holds the kernel's gh-token"; fi
if grep -qiE '^[A-Za-z]+=.*telegram' "$sd/bulig-worker.service"; then bad "the worker unit holds the Telegram bot token"; else ok "the worker unit never holds the Telegram bot token (no setting names it)"; fi
if value bulig-worker.service LoadCredential | grep -qE 'pg-url|gh-token|config|worker-tokens'; then bad "the worker unit holds a kernel secret or the config"; else ok "the worker unit holds no kernel secret and no config"; fi
if [ "$(value bulig.service Environment | tr '\n' ' ')" = "HOME=/var/lib/bulig PATH=/usr/local/bin:/usr/bin:/bin " ]; then ok "the kernel's environment is only HOME and PATH (no secret in it)"; else bad "kernel environment: $(value bulig.service Environment)"; fi

echo "network and sockets: what each unit can reach"
DENY="127.0.0.0/8 ::1/128 169.254.0.0/16 fe80::/10 224.0.0.0/4 ff00::/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7 198.18.0.0/15"
INACC="-/run/tailscale -/run/snapd.socket -/run/docker.sock -/var/run/docker.sock"
RES="/run/systemd/resolve/resolv.conf:/etc/resolv.conf"
# the worker: AF_UNIX and AF_NETLINK for Claude Code's Bash sandbox (Jasher, 21 Oct 2026), the gateway address and nothing else local, and
# because it has AF_UNIX, the Postgres socket folder and the system bus hidden as well
INACC_WORKER="$INACC -/run/postgresql -/var/run/postgresql -/run/dbus -/run/snapd-snap.socket -/run/systemd/userdb -/run/systemd/resolve/io.systemd.Resolve -/run/systemd/resolve/io.systemd.Resolve.Monitor -/run/user"
want bulig-worker.service RestrictAddressFamilies "AF_UNIX AF_INET AF_INET6 AF_NETLINK"
want bulig-worker.service IPAddressDeny "$DENY"
want bulig-worker.service IPAddressAllow "127.0.0.0/8 ::1/128 198.18.74.1/32"
want bulig-worker.service NetworkNamespacePath /run/netns/bulig-worker
want bulig-worker.service InaccessiblePaths "$INACC_WORKER"
want bulig-worker.service BindReadOnlyPaths "$RES"
# the kernel: keeps AF_UNIX for Postgres, the gateway address only; a Mac worker's /32 comes from a drop-in, none by default
want bulig.service RestrictAddressFamilies "AF_UNIX AF_INET AF_INET6"
want bulig.service IPAddressDeny "$DENY"
want bulig.service IPAddressAllow "127.74.3.1/32 198.18.74.1/32"
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
for u in bulig.service bulig-worker.service bulig-backup.service bulig-restore-drill.service bulig-loopback.service bulig-netns.service bulig-pasta.service; do
  if [ "$(value "$u" IPAddressDeny | wc -l | tr -d ' ')" = "1" ]; then ok "$u has an IPAddressDeny line"; else bad "$u has no (or two) IPAddressDeny lines"; fi
  allow=" $(value "$u" IPAddressAllow) "
  # The worker's loopback is its own (its own network namespace), so it alone may allow 127.0.0.0/8 and ::1, and only while it has the namespace.
  if [ "$u" = "bulig-worker.service" ] && [ "$(value "$u" NetworkNamespacePath)" = "/run/netns/bulig-worker" ]; then allow="${allow/ 127.0.0.0\/8 / }"; allow="${allow/ ::1\/128 / }"; fi
  case "$allow" in
    *" 127.0.0.1/32 "* | *" 127.0.0.0/8 "* | *" localhost "* | *" any "* | *" 0.0.0.0/0 "* | *" 172.16.0.1/32 "* | *" ::1/128 "* | *" 127.0.0.53/32 "* | *" 100.64.0.0/10 "*) bad "$u allows localhost, the DNS stub, a whole range, the docker bridge or everything: $(value "$u" IPAddressAllow)" ;;
    *) ok "$u does not allow 127.0.0.1, localhost, the DNS stub, Tailscale as a range, the docker bridge or everything" ;;
  esac
done
# systemd-run refuses a symbolic name (localhost, link-local, multicast, any) inside a list, and the fence check copies
# unit values into systemd-run, so no IP list anywhere in the kit may use one (found on the server, 20 Oct 2026).
sym_hits="$(grep -nE '^(IPAddressDeny|IPAddressAllow)=.*\b(localhost|link-local|multicast)\b' "$sd"/*.service 2>/dev/null; grep -nE 'BULIG_IP_DENY_PRIVATE=.*\b(localhost|link-local|multicast)\b' "$deploy/lib/common.sh")"
if [ -z "$sym_hits" ]; then ok "no IP list in the units or lib/common.sh uses a symbolic name (systemd-run cannot parse one in a list)"; else bad "a symbolic name in an IP list: $sym_hits"; fi
if [ "$(value bulig.service SetCredential)" = "telegram-token:none" ]; then ok "the kernel starts before cutover with no bot token (SetCredential default none)"; else bad "bulig.service has no SetCredential=telegram-token:none (and nothing else), so the missing token file stops the kernel before cutover"; fi
if grep -qE '^(Environment|EnvironmentFile|PassEnvironment)=.*(TELEGRAM|telegram)' "$sd/bulig.service"; then bad "bulig.service passes the bot token through the environment"; else ok "bulig.service gives the bot token only as a credential, never in the environment"; fi
TG_CUT="$(sed -n '/^## Cutover/,/^## Rollback/p' "$deploy/RUNBOOK.md")"
# The cutover order: each marker must come after the one before it (byte offsets inside the section).
order_ok=1 prev=0
for m in 'systemctl start bulig-backup.service' 'bulig.mjs status > <mac jobs file>' 'launchctl bootout' '.backup <snapshot path>' 'systemctl stop bulig-worker bulig bulig-backup.timer bulig-restore-drill.timer' \
  'ALTER DATABASE bulig RENAME TO bulig_precut' "CREATE DATABASE bulig OWNER bulig" '--to-credential pg-url --dry-run' "--to-credential pg-url'" \
  'set-secret.sh --credential telegram-token' 'systemctl start bulig bulig-worker' "bulig-cli.sh status' | diff <mac jobs file> -" 'DROP DATABASE bulig_precut'; do
  n="$(grep -boF -- "$m" <<<"$TG_CUT" | head -1 | cut -d: -f1)"
  if [ -z "$n" ] || [ "$n" -le "$prev" ]; then order_ok=0; echo "    cutover order: '$m' missing or out of order" >&2; break; fi
  prev="$n"
done
if [ "$order_ok" -eq 1 ]; then ok "the Cutover runs backup, Mac job list, Mac stop, snapshot, stop, rename, empty record, dry run, copy, bot token, start, status, and drops bulig_precut last"; else bad "the Cutover steps are missing or out of order"; fi
if grep -q "Keep \`bulig_precut\`" <<<"$TG_CUT" && grep -q "only with Jasher's yes" <<<"$TG_CUT"; then ok "the Cutover keeps bulig_precut until Jasher says to drop it"; else bad "the Cutover does not keep bulig_precut or drops it without Jasher's yes"; fi
if grep -q -- '--to-env' <<<"$(sed -n '/^8\. \*\*Copy over the old record/,/^9\. \*\*Synthetic/p' "$deploy/RUNBOOK.md")$TG_CUT"; then bad "step 8 or the Cutover passes the database URL through an environment variable (--to-env)"; else ok "step 8 and the Cutover read the database URL from the pg-url credential (--to-credential), never an environment variable"; fi
if grep -q "set-secret.sh --credential telegram-token'" <<<"$TG_CUT" && grep -q 'SetCredential=telegram-token:none' <<<"$TG_CUT" && ! grep -q 'add `telegram-token` to `BULIG_CREDENTIALS`' <<<"$TG_CUT"; then ok "the Cutover installs the bot token with set-secret and describes the wiring the release already has"; else bad "the Cutover's bot-token step does not match the units (set-secret --credential telegram-token, SetCredential default none)"; fi
if [ "$(value bulig-worker.service SetCredential)" = "github-read-token:none" ]; then ok "the worker starts without a read token (SetCredential default none)"; else bad "bulig-worker.service has no SetCredential=github-read-token:none, so a missing token file stops the unit"; fi
for u in bulig.service bulig-worker.service; do
  if [ "$(value "$u" LimitCORE)" = "0" ]; then ok "$u writes no core dump (LimitCORE=0)"; else bad "$u can write a core dump holding a credential"; fi
done
for u in bulig.service bulig-worker.service bulig-backup.service bulig-restore-drill.service bulig-pasta.service; do
  missing=""
  for t in 127.0.0.0/8 ::1/128 169.254.0.0/16 fe80::/10 224.0.0.0/4 ff00::/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7 198.18.0.0/15; do
    case " $(value "$u" IPAddressDeny) " in *" $t "*) ;; *) missing="$missing $t" ;; esac
  done
  if [ -z "$missing" ]; then ok "$u denies localhost, link-local, multicast, 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7 and the benchmark range 198.18/15"; else bad "$u does not deny:$missing"; fi
  if grep -qE '127\.0\.0\.53' <(grep -v '^#' "$sd/$u"); then bad "$u names the DNS stub 127.0.0.53 in a setting"; else ok "$u does not name the DNS stub (DNS goes through resolved's upstream list)"; fi
done
# The worker has exactly AF_UNIX, AF_NETLINK and IP (Claude Code's sandbox needs the first two; nothing needs AF_PACKET or any other family).
wf=" $(value bulig-worker.service RestrictAddressFamilies) "
case "$wf" in *AF_PACKET* | *"~"*) bad "the worker unit allows a raw or every other socket family: $wf" ;; *) ok "the worker unit allows no raw socket family and is an allow list" ;; esac
if [ "$(tr ' ' '\n' <<<"$wf" | grep -c '^AF_')" = "4" ]; then ok "the worker unit allows four families only"; else bad "the worker unit's families: $wf"; fi
WSVC="$(cat "$sd/bulig-worker.service")"
if grep -q "Other tenants' ABSTRACT unix sockets were a known limit here before the namespace" <<<"$WSVC" && grep -q '/etc/apparmor.d/bulig-bwrap' <<<"$WSVC" && grep -q 'EAFNOSUPPORT' <<<"$WSVC" && grep -q 'NETLINK_ROUTE' <<<"$WSVC" && grep -q 'only after it has proven the probe is in that namespace' <<<"$WSVC"; then ok "the worker unit says why it has AF_UNIX and AF_NETLINK, names the AppArmor profile, and says the abstract-socket limit is closed by its own namespace (tried only after the guard)"; else bad "the worker unit's comment does not explain its families honestly"; fi
if grep -q 'has no AF_UNIX' <<<"$WSVC" || grep -q 'if AF_UNIX were ever allowed' <<<"$WSVC"; then bad "the worker unit still claims it has no AF_UNIX"; else ok "the worker unit no longer claims it has no AF_UNIX"; fi
case " $(value bulig.service RestrictAddressFamilies) " in *AF_UNIX*) ok "the kernel keeps AF_UNIX (its Postgres socket): a documented limit, see the RUNBOOK" ;; *) bad "the kernel unit lost AF_UNIX, so it cannot reach Postgres" ;; esac
if grep -q '^## Known limits' "$deploy/RUNBOOK.md" && sed -n '/^## Known limits/,/^## Must be proven/p' "$deploy/RUNBOOK.md" | grep -q 'AppArmor profile for the kernel with `deny unix addr=@\*\*,`' && sed -n '/^## Known limits/,/^## Must be proven/p' "$deploy/RUNBOOK.md" | grep -qi 'abstract'; then ok "the RUNBOOK's Known limits name the kernel's abstract-socket reach and the AppArmor next step"; else bad "RUNBOOK Known limits section is missing the abstract-socket limit"; fi
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
PC="$(sed -n '/^12\. \*\*Postcheck/,/^## /p' "$deploy/RUNBOOK.md")"
if grep -q 'the run state of a service a timer starts' <<<"$PC" && grep -q 'a `failed` one is a `warn` line that names the unit' <<<"$PC" && grep -q 'a container whose image no longer runs in any container, or a known container on a new image still fails' <<<"$PC"; then ok "the RUNBOOK's postcheck step says what is reported and not compared, and what still fails"; else bad "RUNBOOK postcheck step does not describe the timer and container rules"; fi
if grep -q 'newest `release-<sha>.before.snapshot`' <<<"$PC" && grep -q -- '--against <file>' <<<"$PC" && grep -q 'A template instance that is in both and changed state still fails' <<<"$PC" && grep -q 'A socket-activated instance, or one systemd no longer knows' <<<"$PC"; then ok "the RUNBOOK's postcheck step names its baseline (the newest release snapshot), --against, and the transient and instance rules"; else bad "RUNBOOK postcheck step does not describe the baselines or the transient and instance rules"; fi
if grep -q '/etc/bulig/postcheck-ignore.txt' <<<"$PC" && grep -q 'but only when no socket can start it' <<<"$PC" && grep -q 'its port is in the kernel.s ephemeral range' <<<"$PC" && grep -q 'a listener of that same process on a port outside the range is in both snapshots' <<<"$PC"; then ok "the RUNBOOK's postcheck step describes the ephemeral-listener rule and the host's ignore list, and that a socket-startable unit still fails"; else bad "RUNBOOK postcheck step does not describe the ephemeral-listener rule or the host's ignore list"; fi
REL7="$(sed -n '/^   7\. takes a fresh "before" snapshot/p' "$deploy/RUNBOOK.md")"
if grep -q 'release-<sha>.before.snapshot' <<<"$REL7" && grep -q 'A postcheck failure does not fail the release or roll it back' <<<"$REL7" && grep -q 'Health decides the release' <<<"$REL7"; then ok "the RUNBOOK's release step says each release takes a before snapshot and that a postcheck failure is reported, not rolled back"; else bad "RUNBOOK release step: no before snapshot or no rollback rule"; fi
UNINST="$(grep -- '- \*\*Remove Bulig completely' "$deploy/RUNBOOK.md")"
if [ "${UNINST%%postcheck.sh*}" != "$UNINST" ] && [ "${UNINST%%postcheck.sh*}" != "${UNINST%%/var/lib/bulig-checks*}" ] && [ "${#UNINST}" -gt 0 ]; then
  before_pc="${UNINST%%\`postcheck.sh\`*}"
  case "$before_pc" in *"/var/lib/bulig-checks"*) bad "uninstall removes /var/lib/bulig-checks before postcheck.sh runs" ;; *) ok "uninstall runs postcheck.sh before the folder it reads is removed" ;; esac
else bad "uninstall text: postcheck order not found"; fi
if grep -q 'ProtectKernelTunables' <(grep -n 'unpacks the tar as root' "$deploy/RUNBOOK.md") && grep -q 'ProtectClock' <(grep -n 'unpacks the tar as root' "$deploy/RUNBOOK.md"); then ok "the RUNBOOK's claim about the unpack sandbox lists the kernel protections it really has"; else bad "RUNBOOK unpack claim"; fi
if grep -q 'Depends on PR #50' "$deploy/RUNBOOK.md"; then ok "the RUNBOOK names its dependency on PR #50 (config credential, gh-token, gateway)"; else bad "no PR #50 dependency note"; fi
if grep -q 'loopback address, so it may treat it as local and trusted' "$deploy/RUNBOOK.md" && ! grep -q 'public anyway' <(grep -v 'not "public anyway"' "$deploy/RUNBOOK.md"); then ok "the RUNBOOK says requests from the gateway address reach wildcard listeners with a loopback source (not 'public anyway')"; else bad "RUNBOOK wildcard-listener wording"; fi

echo "the AppArmor profile for bubblewrap"
AA="$deploy/apparmor/bulig-bwrap"
if [ -f "$AA" ] && grep -qx 'profile bulig-bwrap /usr/bin/bwrap flags=(unconfined) {' "$AA"; then ok "deploy/apparmor/bulig-bwrap attaches to /usr/bin/bwrap only, as profile bulig-bwrap"; else bad "the profile header: $(grep profile "$AA" 2>&1)"; fi
rules="$(sed -n '/^profile /,/^}/p' "$AA" | sed '1d;$d' | sed 's/^ *//' | grep -v '^#' | grep -v '^$' | tr '\n' '|')"
if [ "$rules" = "userns,|include if exists <local/bulig-bwrap>|" ]; then ok "and grants userns and nothing else (plus the local override include)"; else bad "the profile's rules: $rules"; fi
if grep -qx 'abi <abi/4.0>,' "$AA" && grep -qx 'include <tunables/global>' "$AA"; then ok "and uses the AppArmor 4.0 abi with the global tunables (Ubuntu 24.04)"; else bad "the profile's abi/include lines"; fi
FP="$(sed -n '/^## Footprint/,/^## Cutover/p' "$deploy/RUNBOOK.md")"
if grep -q '/etc/apparmor.d/bulig-bwrap' <<<"$FP" && grep -q 'apparmor_parser -r' <<<"$FP"; then ok "the RUNBOOK's footprint lists the AppArmor profile and how it is loaded"; else bad "the RUNBOOK's footprint does not list the AppArmor profile"; fi
if grep -q 'apparmor_parser -R /etc/apparmor.d/bulig-bwrap' <<<"$UNINST" && grep -q 'rm /etc/apparmor.d/bulig-bwrap' <<<"$UNINST"; then ok "the RUNBOOK's removal steps unload and remove the AppArmor profile"; else bad "the removal steps leave the AppArmor profile behind"; fi
ITEM6="$(sed -n '/^## Must be proven on the server first/,/^## Things to know/p' "$deploy/RUNBOOK.md" | sed -n '/^6\. /,/^7\. /p')"
if grep -q 'build and test stages ran Bash commands in the sandbox' <<<"$ITEM6" && grep -q "test stage's verdict PASS" <<<"$ITEM6" && grep -q 'bwrap-sandbox' <<<"$ITEM6" && grep -q 'Correction, 21 Oct 2026' <<<"$ITEM6" && grep -q 'wrongly counted' <<<"$ITEM6"; then ok "server-first item 6 needs a job whose build and test stages ran Bash in the sandbox (test verdict PASS) and the bwrap probe, and says it was wrongly counted on 21 Oct"; else bad "server-first item 6: $ITEM6"; fi
if grep -q 'one real synthetic job\.' <<<"$ITEM6" || grep -q 'runs without `AF_UNIX`' <<<"$ITEM6"; then bad "item 6 still counts any synthetic job, or still says the worker has no AF_UNIX"; else ok "and no longer counts any synthetic job"; fi
KL="$(sed -n '/^## Known limits/,/^## Must be proven/p' "$deploy/RUNBOOK.md")"
if grep -q "The worker can reach other tenants' abstract unix sockets too" <<<"$KL" || grep -q "Commands in Claude Code's sandbox have no network\*\*" <<<"$KL" || grep -q 'Planned follow-up: run the worker in its own network namespace' <<<"$KL"; then bad "the RUNBOOK's Known limits still list the worker's abstract-socket reach or the sandbox's missing network, which the namespace closed"; else ok "the RUNBOOK's Known limits no longer list the worker's abstract-socket reach or the sandbox's missing network (the namespace closed both)"; fi
CL="$(sed -n '/^## Known limits/,/^## Must be proven/p' "$deploy/RUNBOOK.md" | sed -n '/^### Closed by the worker.s network namespace/,/^## /p')"
if grep -q "other tenants' abstract unix sockets" <<<"$CL" && grep -q 'netns guard' <<<"$CL" && grep -q "npm" <<<"$CL" && grep -q "sandbox's own allowlist" <<<"$CL"; then ok "the RUNBOOK says what the namespace closed: the worker's abstract-socket reach (tried only after the netns guard) and the sandbox network (npm through the sandbox's own allowlist)"; else bad "the RUNBOOK does not say what the namespace closed: $CL"; fi
if grep -q '198.18.74.1.*reaches every listener on the host bound to all addresses' <<<"$KL" && grep -q "pasta's unit" <<<"$KL"; then ok "the RUNBOOK's Known limits say 198.18.74.1 reaches every listener on all addresses through pasta, and that pasta's unit filter is the guard"; else bad "Known limits miss the pasta/198.18.74.1 limit"; fi
if grep -q "The worker can connect to other path sockets whose permissions let it in" <<<"$KL" && grep -q 'never a connection' <<<"$KL" && grep -q 'The network namespace does \*\*not\*\* change this' <<<"$KL" && ! grep -q 'Path sockets are hidden' "$deploy/RUNBOOK.md"; then ok "the RUNBOOK says only listed paths are hidden, other path sockets stay connectable (listed by the fence check), and the namespace does not change it"; else bad "the RUNBOOK's path-socket limit is missing or still claims every path socket is hidden"; fi
if grep -q 'InaccessiblePaths hides THESE paths only' <<<"$WSVC" && grep -q 'KNOWN LIMIT: every OTHER path socket' <<<"$WSVC" && ! grep -q 'hides the unix sockets a path connection could reach' <<<"$WSVC"; then ok "the worker unit says which paths are hidden and that other path sockets stay connectable"; else bad "the worker unit's InaccessiblePaths comment overclaims"; fi
if grep -q 'KNOWN LIMIT: commands inside the sandbox have NO NETWORK' <<<"$WSVC"; then bad "the worker unit still says sandboxed commands have no network"; else ok "the worker unit no longer says sandboxed commands have no network (the proxy is on the namespace's own loopback)"; fi
if grep -q 'the worker is a different unit with no AF_UNIX' "$sd/bulig.service"; then bad "the kernel unit still says the worker has no AF_UNIX"; else ok "the kernel unit no longer says the worker has no AF_UNIX"; fi

echo "the gateway addresses"
gw="127.74.3.1"
ngw="198.18.74.1"
case "$(value bulig-worker.service ExecStart)" in *"--kernel http://$ngw:7431 "*) ok "the worker connects to http://$ngw:7431 (from its own network namespace, through pasta)" ;; *) bad "worker URL: $(value bulig-worker.service ExecStart)" ;; esac
if [ "$(value bulig-loopback.service ExecStart | tr '\n' '|')" = "/usr/bin/ip address replace $gw/32 dev lo|/usr/bin/ip address replace $ngw/32 dev lo|" ] && [ "$(value bulig-loopback.service ExecStop | tr '\n' '|')" = "-/usr/bin/ip address del $gw/32 dev lo|-/usr/bin/ip address del $ngw/32 dev lo|" ]; then ok "bulig-loopback.service puts $gw/32 and $ngw/32 on lo and takes both off again (an address already gone is not a failure)"; else bad "loopback exec: $(value bulig-loopback.service ExecStart | tr '\n' '|') / $(value bulig-loopback.service ExecStop | tr '\n' '|')"; fi
want bulig-loopback.service Type oneshot
want bulig-loopback.service RemainAfterExit yes
want bulig-loopback.service Before "bulig.service bulig-worker.service bulig-pasta.service"
want bulig-loopback.service CapabilityBoundingSet CAP_NET_ADMIN
want bulig-loopback.service RestrictAddressFamilies "AF_NETLINK AF_UNIX"
want bulig.service Requires bulig-loopback.service
if value bulig-worker.service Wants | grep -q bulig-loopback.service && value bulig-worker.service After | grep -q bulig-loopback.service; then ok "the worker wants and starts after the gateway address"; else bad "worker ordering"; fi
if value bulig.service After | grep -q bulig-loopback.service; then ok "the kernel starts after the gateway address"; else bad "kernel ordering"; fi

echo "the worker's own network namespace (bulig-netns.service)"
NS="$sd/bulig-netns.service"
want bulig-netns.service Type oneshot
want bulig-netns.service RemainAfterExit yes
want bulig-netns.service ExecStartPre "-/usr/bin/ip netns delete bulig-worker"
want bulig-netns.service ExecStart "/usr/bin/ip netns add bulig-worker"
want bulig-netns.service ExecStop "/usr/bin/ip netns delete bulig-worker"
want bulig-netns.service CapabilityBoundingSet CAP_SYS_ADMIN
want bulig-netns.service RestrictNamespaces net
want bulig-netns.service IPAddressDeny any
want bulig-netns.service NoNewPrivileges true
want bulig-netns.service Before "bulig-pasta.service bulig-worker.service"
# `ip netns add` publishes the namespace as a bind mount under /run/netns; in a mount namespace of the unit's own nobody else would see it
mns=""
for k in ProtectSystem ProtectHome PrivateTmp PrivateDevices PrivateMounts ReadWritePaths ReadOnlyPaths InaccessiblePaths BindPaths BindReadOnlyPaths TemporaryFileSystem ProtectKernelTunables ProtectKernelModules ProtectKernelLogs ProtectControlGroups ProtectProc ProcSubset ProtectHostname RootDirectory MountAPIVFS RuntimeDirectory StateDirectory; do
  if has bulig-netns.service "$k"; then mns="$mns $k"; fi
done
if [ -z "$mns" ]; then ok "bulig-netns.service has no setting that gives it a mount namespace of its own (the namespace's bind mount must land in the host's)"; else bad "bulig-netns.service has a mount-namespace setting:$mns"; fi
if grep -q 'NO MOUNT NAMESPACE, on purpose' "$NS"; then ok "and says why"; else bad "bulig-netns.service does not say why it has no mount namespace"; fi

echo "pasta, the namespace's way out (bulig-pasta.service)"
PS="$sd/bulig-pasta.service"
pexec="$(value bulig-pasta.service ExecStart)"
if [ "$pexec" = "/usr/bin/pasta -f -e --config-net --netns /run/netns/bulig-worker --runas 0 --netns-only -t none -u none -T none -U none --no-map-gw" ]; then ok "pasta runs in the foreground, logs to stderr, configures the namespace, stays root (--runas 0), joins the netns only, forwards no port either way, and maps no gateway"; else bad "pasta ExecStart: $pexec"; fi
for f in "-t none" "-u none" "-T none" "-U none" "--no-map-gw"; do
  case " $pexec " in *" $f "*) ok "pasta has $f" ;; *) bad "pasta lacks $f (a namespace port or the gateway would be mapped to the host)" ;; esac
done
want bulig-pasta.service Type simple
want bulig-pasta.service Restart always
if [ "$(value bulig-pasta.service ExecStartPost)" = "+/usr/bin/timeout 10 /bin/sh -c 'until /usr/bin/ip -n bulig-worker -o addr show scope global | /usr/bin/grep -q .; do /usr/bin/sleep 0.1; done'" ]; then ok "pasta is ready only once the namespace has a global address (10 s, then the start fails)"; else bad "pasta has no readiness wait (Type=simple is ready before the namespace is configured): $(value bulig-pasta.service ExecStartPost)"; fi
want bulig-pasta.service BindsTo bulig-netns.service
if value bulig-pasta.service After | grep -q 'bulig-netns.service'; then ok "pasta starts after the namespace"; else bad "pasta ordering: $(value bulig-pasta.service After)"; fi
want bulig-pasta.service Before bulig-worker.service
want bulig-pasta.service CapabilityBoundingSet "CAP_SYS_ADMIN CAP_NET_ADMIN"
want bulig-pasta.service AmbientCapabilities ""
want bulig-pasta.service RestrictNamespaces "ipc mnt net uts"
want bulig-pasta.service RestrictAddressFamilies "AF_INET AF_INET6 AF_NETLINK"
want bulig-pasta.service DevicePolicy closed
want bulig-pasta.service DeviceAllow "/dev/net/tun rw"
want bulig-pasta.service IPAddressDeny "$DENY"
want bulig-pasta.service IPAddressAllow "198.18.74.1/32"
for k in NoNewPrivileges PrivateTmp ProtectKernelTunables ProtectKernelModules ProtectKernelLogs ProtectControlGroups ProtectClock ProtectHostname LockPersonality MemoryDenyWriteExecute RestrictRealtime RestrictSUIDSGID; do
  want bulig-pasta.service "$k" true
done
want bulig-pasta.service ProtectSystem strict
want bulig-pasta.service ProtectHome yes
want bulig-pasta.service ProtectProc invisible
want bulig-pasta.service LimitCORE 0
if has bulig-pasta.service MemoryMax && has bulig-pasta.service TasksMax; then ok "pasta is capped (MemoryMax $(value bulig-pasta.service MemoryMax), TasksMax $(value bulig-pasta.service TasksMax))"; else bad "pasta has no memory or task cap"; fi
for k in User PrivateNetwork PrivateUsers PrivateDevices NetworkNamespacePath; do
  if has bulig-pasta.service "$k"; then bad "bulig-pasta.service sets $k=$(value bulig-pasta.service "$k")"; else ok "bulig-pasta.service does not set $k (it runs as root, in the host's network namespace, with /dev/net/tun)"; fi
done
if grep -q "Couldn't switch to pasta namespaces: Operation not permitted" "$PS" && grep -q 'KNOWN LIMIT: the filter matches ADDRESSES, NOT PORTS' "$PS" && grep -q 'isolation.c' "$PS"; then ok "the pasta unit says why --runas 0, where its capability list comes from, and the addresses-not-ports limit"; else bad "the pasta unit's comments are missing the reasons"; fi

echo "the worker runs only in its namespace"
want bulig-worker.service BindsTo bulig-netns.service
if value bulig-worker.service After | grep -q 'bulig-netns.service' && value bulig-worker.service After | grep -q 'bulig-pasta.service' && value bulig-worker.service Wants | grep -q 'bulig-pasta.service'; then ok "the worker starts after the namespace and pasta, and wants pasta"; else bad "worker namespace ordering: After=$(value bulig-worker.service After) Wants=$(value bulig-worker.service Wants)"; fi
if ! value bulig-worker.service IPAddressAllow | grep -q '127.74.3.1'; then ok "the worker no longer allows 127.74.3.1 (in its namespace that is its own loopback; the gateway is 198.18.74.1)"; else bad "the worker still allows 127.74.3.1"; fi

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
assert w['listen']==['127.74.3.1', '198.18.74.1'] and w['port']==7431 and w['workers']['vps']['credential']=='worker-tokens'
assert c['pluginConfig']['gate-evidence']['mode']=='warn' and c['pluginConfig']['gate-promise']['mode']=='warn'
assert c['dbPath'].startswith('/var/lib/bulig/'), 'dbPath'
" "$cfg" 2>"$work/err"; then ok "the template: Postgres from the pg-url credential, gateway on 127.74.3.1 and 198.18.74.1, port 7431, for worker vps, gates in warn, Telegram and the local worker off"; else bad "config template: $(cat "$work/err")"; fi

if grep -q -- 'Run `postcheck.sh` with `--against /var/lib/bulig-checks/precheck.snapshot`' <<<"$UNINST"; then ok "the removal check compares against the precheck, not the last release's snapshot"; else bad "the removal step does not use --against precheck.snapshot"; fi
if grep -q 'up to 400, sorted by path' <<<"$KL" && ! grep -q 'lists each one in every health run' "$deploy/RUNBOOK.md"; then ok "the RUNBOOK says the fence check lists up to 400 path sockets, and that a hit cap is said"; else bad "the RUNBOOK still says every path socket is listed"; fi
finish
