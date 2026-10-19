#!/usr/bin/env bash
# Refresh the drop-in that adds this machine's own public addresses to the worker's IPAddressDeny= (root-owned, under /etc/systemd/system).
# The addresses are read from `ip -o addr` every time, never written into a unit file by hand. Run it after the host's address changes
# (health.sh warns when the drop-in no longer matches), then restart bulig-worker. setup-user.sh and every release run the same function.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
need_root
[ "$#" -eq 0 ] || die "takes no arguments"

addrs="$(host_addresses | tr '\n' ' ')"
[ -n "${addrs% }" ] || echo "host-addresses: WARNING no public address found in 'ip -o addr show scope global'. The drop-in will name none." >&2
write_host_dropin bulig-worker.service
echo "host-addresses: bulig-worker.service.d/10-host-addresses.conf denies: ${addrs:-nothing}"
if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload; fi
echo "host-addresses: done. Restart bulig-worker.service for it to take effect."
