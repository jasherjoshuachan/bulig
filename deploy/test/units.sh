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
  want "$u" RestrictAddressFamilies "AF_UNIX AF_INET AF_INET6"
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
if [ "$worker_creds" = "claude-token:/etc/bulig/claude-token worker-token:/etc/bulig/worker-token " ]; then ok "the worker holds claude-token and worker-token only"; else bad "worker credentials: $worker_creds"; fi
if value bulig.service LoadCredential | grep -q claude; then bad "the kernel unit holds the Claude token"; else ok "the kernel unit never holds the Claude token"; fi
if value bulig-worker.service LoadCredential | grep -qE 'pg-url|gh-token|config|worker-tokens'; then bad "the worker unit holds a kernel secret or the config"; else ok "the worker unit holds no kernel secret and no config"; fi
if [ "$(value bulig.service Environment | tr '\n' ' ')" = "HOME=/var/lib/bulig PATH=/usr/local/bin:/usr/bin:/bin " ]; then ok "the kernel's environment is only HOME and PATH (no secret in it)"; else bad "kernel environment: $(value bulig.service Environment)"; fi

echo "network filtering: what each unit can reach"
DENY_PRIV="localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7"
DENY_KERNEL="localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 fc00::/7"
want bulig.service IPAddressDeny "$DENY_KERNEL"
want bulig.service IPAddressAllow "127.74.3.1/32 127.0.0.53/32 100.64.0.0/10"
want bulig-worker.service IPAddressDeny "$DENY_PRIV"
want bulig-worker.service IPAddressAllow "127.74.3.1/32 127.0.0.53/32"
for u in bulig-backup.service bulig-restore-drill.service; do
  want "$u" IPAddressDeny "$DENY_PRIV"
  want "$u" IPAddressAllow "127.0.0.53/32"
  want "$u" Environment "DOCKER_CONFIG=/var/lib/bulig-checks/docker"
done
want bulig-loopback.service IPAddressDeny any
for u in bulig.service bulig-worker.service bulig-backup.service bulig-restore-drill.service bulig-loopback.service; do
  if [ "$(value "$u" IPAddressDeny | wc -l | tr -d ' ')" = "1" ]; then ok "$u has an IPAddressDeny line"; else bad "$u has no (or two) IPAddressDeny lines"; fi
  case " $(value "$u" IPAddressAllow) " in
    *" 127.0.0.1/32 "* | *" 127.0.0.0/8 "* | *" localhost "* | *" any "* | *" 0.0.0.0/0 "* | *" 172.17.0.1/32 "* | *" ::1/128 "*) bad "$u lets localhost, the docker bridge or everything through: $(value "$u" IPAddressAllow)" ;;
    *) ok "$u does not allow 127.0.0.1, localhost, the docker bridge or everything" ;;
  esac
done
for u in bulig.service bulig-worker.service bulig-backup.service bulig-restore-drill.service; do
  case " $(value "$u" IPAddressDeny) " in *" localhost "* | *" link-local "* | *" multicast "* | *" 172.16.0.0/12 "*) ok "$u denies localhost, link-local, multicast and the 172.16/12 range (docker bridges)" ;; *) bad "$u IPAddressDeny: $(value "$u" IPAddressDeny)" ;; esac
done
# The worker is the one that runs Claude: it must not be able to reach Tailscale peers either.
case " $(value bulig-worker.service IPAddressDeny) " in *" 100.64.0.0/10 "*) ok "the worker also denies Tailscale (100.64.0.0/10)" ;; *) bad "worker does not deny Tailscale" ;; esac
case " $(value bulig.service IPAddressDeny) " in *" 100.64.0.0/10 "*) bad "the kernel denies Tailscale, so the Mac worker could not reach it" ;; *) ok "the kernel does not deny Tailscale (the Mac worker comes in that way)" ;; esac

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
flags="$(printf '%s\n' "$cmdline" | grep -oE ' --[a-z-]+' | tr -d ' ' | sort | tr '\n' ' ')"
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
