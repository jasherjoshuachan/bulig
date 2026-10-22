#!/usr/bin/env bash
# Refresh the drop-ins that add this machine's own public addresses to the worker's and pasta's IPAddressDeny= (root-owned, under
# /etc/systemd/system; the worker's packets leave the host as pasta's).
# The addresses are read from `ip -o addr` every time, never written into a unit file by hand. Run it after the host's address changes
# (health.sh warns when the drop-in no longer matches), then restart bulig-pasta and bulig-worker. setup-user.sh and every release run the same function.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
need_root
[ "$#" -eq 0 ] || die "takes no arguments"

addrs="$(host_addresses | tr '\n' ' ')"
[ -n "${addrs% }" ] || echo "host-addresses: WARNING no public address found in 'ip -o addr show scope global'. The drop-in will name none." >&2
for u in $HOST_DROPIN_UNITS; do
  write_host_dropin "$u"
  echo "host-addresses: $u.d/10-host-addresses.conf denies: ${addrs:-nothing}"
done
if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload; fi
echo "host-addresses: done. Restart bulig-pasta.service and bulig-worker.service for it to take effect."
