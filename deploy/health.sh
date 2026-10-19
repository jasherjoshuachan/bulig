#!/usr/bin/env bash
# Is Bulig healthy on this host? Run as root on ths-prod-01. Exit 0 only if all three hold:
#   1. bulig.service and bulig-worker.service are active
#   2. the kernel holds the executor lease and keeps renewing it (two reads 11 s apart, the heartbeat is every 10 s)
#   3. the Postgres cluster "16 bulig" is online on port 5436
# usage: health.sh [--wait <seconds>]   (--wait: how long to give the service to take the lease after a start, default 30)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
need_root

wait_s=30
if [ "${1:-}" = "--wait" ]; then wait_s="${2:?--wait needs a number of seconds}"; fi
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

# The worker is a separate unit under a separate user. It must be up, but a worker problem does not hide the kernel checks below.
if systemctl is-active --quiet bulig-worker.service; then
  ok "bulig-worker.service active"
else
  bad "bulig-worker.service is $(systemctl is-active bulig-worker.service 2>&1 || true)"
fi

# 2. Read the lease row twice, as the bulig role over 127.0.0.1:5436 (password through a private PGPASSFILE, never a command line).
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
PGPASSFILE="$(pg_passfile "$(cred_path pg-url)" "$work")"
export PGPASSFILE
lease_row() {
  "$(pg_bin psql)" -X -q -w -h 127.0.0.1 -p "$BULIG_PG_PORT" -U bulig -d bulig -tA -F '|' \
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

if [ "$fail" -eq 0 ]; then echo "health: ok"; else echo "health: FAILED"; exit 1; fi
