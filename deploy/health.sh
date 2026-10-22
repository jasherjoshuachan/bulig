#!/usr/bin/env bash
# Is Bulig healthy on this host? Run as root on ths-prod-01. Exit 0 only if all of these hold:
#   1. bulig.service and bulig-worker.service are active, and so is what the worker's network stands on: the gateway addresses on lo
#      (127.74.3.1 and 198.18.74.1, bulig-loopback.service), the worker's network namespace (/run/netns/bulig-worker, bulig-netns.service) and
#      pasta (bulig-pasta.service), which has given the namespace an address of its own
#   2. the kernel holds the executor lease and keeps renewing it (two reads 11 s apart, the heartbeat is every 10 s)
#   3. the Postgres cluster "16 bulig" is online on port 5436
#   4. the fence holds (fence-check.sh): from inside each Bulig unit's properties, other tenants' services, the docker bridge, tailscale, the
#      machine's own addresses and unix sockets (other tenants' abstract sockets, tailscaled, docker) cannot be reached, and what the units need can
#   It also WARNS (does not fail) when the host's addresses no longer match the worker's or pasta's drop-in, or a new service listens on every
#   address.
# usage: health.sh [--wait <seconds>] [--no-fence]   (--wait: how long to give the service to take the lease after a start, default 30)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
# shellcheck source=lib/fence.sh
. "$here/lib/fence.sh"
need_root

wait_s=30
fence=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --wait) wait_s="${2:?--wait needs a number of seconds}"; shift 2 ;;
    --no-fence) fence=0; shift ;;
    *) die "usage: health.sh [--wait <seconds>] [--no-fence]" ;;
  esac
done
fail=0
bad() { echo "FAIL  $*"; fail=1; }
ok() { echo "ok    $*"; }

# 3 first: the other two need the database.
if pg_lsclusters -h | awk -v v="$BULIG_PG_VERSION" -v c="$BULIG_PG_CLUSTER" -v p="$BULIG_PG_PORT" '$1 == v && $2 == c && $3 == p && $4 == "online" {found = 1} END {exit !found}'; then
  ok "cluster $BULIG_PG_VERSION $BULIG_PG_CLUSTER online on port $BULIG_PG_PORT"
else
  bad "cluster $BULIG_PG_VERSION $BULIG_PG_CLUSTER is not online on port $BULIG_PG_PORT"
  echo "health: FAILED"
  exit 1
fi

# 1
if systemctl is-active --quiet bulig.service; then
  ok "bulig.service active"
else
  bad "bulig.service is $(systemctl is-active bulig.service 2>&1 || true)"
  echo "health: FAILED"
  exit 1
fi

if systemctl is-active --quiet bulig-loopback.service; then
  ok "bulig-loopback.service active"
else
  bad "bulig-loopback.service is $(systemctl is-active bulig-loopback.service 2>&1 || true): the worker cannot reach the kernel"
fi
lo_addrs="$(ip -o addr show dev lo 2>/dev/null || true)"
for a in "$BULIG_NETNS_GATEWAY" "$BULIG_GATEWAY_ADDR"; do
  if grep -q " inet $a/32 " <<<"$lo_addrs"; then ok "$a/32 is on lo"; else bad "$a/32 is not on lo: the gateway cannot listen there (restart bulig-loopback.service)"; fi
done

# The worker's network: its own namespace, and pasta, its only way out.
if systemctl is-active --quiet bulig-netns.service && [ -e "$R$BULIG_NETNS_PATH" ]; then
  ok "bulig-netns.service active ($BULIG_NETNS_PATH exists)"
else
  bad "the worker's network namespace is not there (bulig-netns.service is $(systemctl is-active bulig-netns.service 2>&1 || true), $BULIG_NETNS_PATH $([ -e "$R$BULIG_NETNS_PATH" ] && echo exists || echo 'is missing'))"
fi
if systemctl is-active --quiet bulig-pasta.service; then
  ok "bulig-pasta.service active"
else
  bad "bulig-pasta.service is $(systemctl is-active bulig-pasta.service 2>&1 || true): the worker has no network"
fi
# pasta copies the host's addresses onto the namespace's eth0 when it starts (--config-net). No global address there means it did not.
if [ -n "$(ip -n "$BULIG_NETNS_NAME" -o addr show scope global 2>/dev/null || true)" ]; then
  ok "the worker's network namespace has an address of its own (pasta set it up)"
else
  bad "the worker's network namespace has no global address: pasta did not set it up (journalctl -u bulig-pasta.service)"
fi

# The worker is a separate unit under a separate user. It must be up, but a worker problem does not hide the kernel checks below.
if systemctl is-active --quiet bulig-worker.service; then
  ok "bulig-worker.service active"
else
  bad "bulig-worker.service is $(systemctl is-active bulig-worker.service 2>&1 || true)"
fi

# 2. Read the lease row twice, as the bulig role over the unix socket, port 5436 (password through a private PGPASSFILE, never a command line).
work="$(private_tmpdir)"
trap 'rm -rf "$work"' EXIT
PGPASSFILE="$(pg_passfile "$(cred_path pg-url)" "$work")"
export PGPASSFILE
lease_row() {
  "$(pg_bin psql)" -X -q -w -h "$BULIG_PG_HOST" -p "$BULIG_PG_PORT" -U bulig -d bulig -tA -F '|' \
    -c "SELECT holder, generation, expires_at > clock_timestamp(), to_char(expires_at, 'YYYY-MM-DD HH24:MI:SS.US') FROM executor_lease" 2>&1 || true
}
row1=""
for _ in $(seq 1 "$wait_s"); do
  row1="$(lease_row)"
  case "$row1" in *"|t|"*) break ;; esac
  sleep 1
done
case "$row1" in
  *"|t|"*) ok "lease held: holder=${row1%%|*}" ;;
  "") bad "no lease row after ${wait_s}s: the kernel has not taken the lease" ;;
  *) bad "lease is not live after ${wait_s}s (row: $row1)" ;;
esac
if [ "$fail" -eq 0 ]; then
  sleep 11
  row2="$(lease_row)"
  IFS='|' read -r h1 g1 _ e1 <<<"$row1"
  IFS='|' read -r h2 g2 l2 e2 <<<"$row2"
  if [ "$l2" != "t" ]; then
    bad "lease expired during the check (row: $row2)"
  elif [ "$h1" != "$h2" ] || [ "$g1" != "$g2" ]; then
    bad "lease changed hands during the check (holder/generation $h1/$g1 became $h2/$g2): the service is restarting in a loop"
  elif [[ ! "$e2" > "$e1" ]]; then
    bad "lease is held but not renewing (expires_at stayed $e1)"
  else
    ok "lease renewing: expires_at $e1 -> $e2 (generation $g2)"
  fi
fi

warn() { echo "warn  $*"; }

# Warnings: the host's own addresses against the worker's drop-in, and services that listen on every address (an allowed address such as
# 127.74.3.1 reaches all of them, because the IP filter matches addresses and not ports).
want_addrs="$(host_addresses | tr '\n' ' ')"
for u in $HOST_DROPIN_UNITS; do
  have_addrs="$(unit_list "$u" IPAddressDeny | tr ' ' '\n' | { grep -E '^[0-9a-f:.]+/(32|128)$' || true; } | sort -u | tr '\n' ' ')"
  for a in $want_addrs; do
    case " $have_addrs " in *" $a "*) ;; *) warn "the host address $a is not in $u's IPAddressDeny. Run host-addresses.sh and restart bulig-pasta and bulig-worker." ;; esac
  done
done
baseline="$BULIG_CHECKS_DIR/precheck.snapshot"
if [ -r "$baseline" ]; then
  known="$(awk '/^## listening tcp sockets/ {on=1; next} /^## / {on=0} on {print $1}' "$baseline" | sort -u)"
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    case "
$known
" in *"
$l
"*) ;; *) warn "a service listens on every address now ($l) and was not there at the precheck. The worker can reach it through $BULIG_NETNS_GATEWAY (pasta)." ;; esac
  done < <(wildcard_listeners)
else
  warn "no precheck snapshot at $baseline, so new listeners on every address cannot be noticed"
fi

# 4. The fence: probes from inside each property set. Needs the kernel to be up for the gateway probe, which is why it runs last.
if [ "$fail" -eq 0 ] && [ "$fence" -eq 1 ]; then
  if "$here/fence-check.sh" all --no-late && "$here/fence-check.sh" worker cli-worker --late-only --late-strict; then
    ok "the fence holds"
  else
    bad "the fence does not hold (see FAIL lines above)"
  fi
fi

if [ "$fail" -eq 0 ]; then echo "health: ok"; else echo "health: FAILED"; exit 1; fi
