#!/usr/bin/env bash
# Let ONE Tailscale peer, the Mac worker, reach the kernel gateway: a root-owned drop-in for bulig.service with that peer's /32 in
# IPAddressAllow=. Until this is run the kernel allows no Tailscale peer at all (the VPS worker only).
#   usage:  set-mac-worker.sh <tailscale IPv4 of the Mac, 100.64.0.0 to 100.127.255.255>
#           set-mac-worker.sh --remove
# It also needs the Mac worker's token (set-secret.sh --worker-token mac) and the VPS's own Tailscale address in "listen" in
# /etc/bulig/config.json; then restart bulig.service.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
need_root

[ "$#" -eq 1 ] || die "usage: set-mac-worker.sh <tailscale IPv4 address of the Mac> | --remove"
dir="$BULIG_UNIT_DIR/bulig.service.d"
file="$dir/20-mac-worker.conf"
if [ "$1" = "--remove" ]; then
  [ ! -L "$file" ] || die "$file is a link. Not touching it."
  need_dir "$BULIG_UNIT_DIR"
  rm -f "$file"
  echo "set-mac-worker: removed (the kernel allows no Tailscale peer)"
else
  ip="$1"
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || die "'$ip' is not a plain IPv4 address (no prefix, no name)"
  o1="${BASH_REMATCH[1]}"; o2="${BASH_REMATCH[2]}"; o3="${BASH_REMATCH[3]}"; o4="${BASH_REMATCH[4]}"
  for o in "$o1" "$o2" "$o3" "$o4"; do
    [[ "$o" =~ ^(0|[1-9][0-9]{0,2})$ ]] && [ "$o" -le 255 ] || die "'$ip' is not a plain IPv4 address (a part is out of range or has a leading zero)"
  done
  { [ "$o1" -eq 100 ] && [ "$o2" -ge 64 ] && [ "$o2" -le 127 ]; } || die "'$ip' is not a Tailscale address (100.64.0.0/10)"
  root_dir 0755 "$dir" >/dev/null
  {
    echo "# Written by deploy/set-mac-worker.sh (root). The one Tailscale peer that may reach the kernel gateway."
    echo "[Service]"
    echo "IPAddressAllow=$ip/32"
  } | install_root_file "$file"
  echo "set-mac-worker: bulig.service allows $ip/32 (the Mac worker) and no other Tailscale peer"
fi
if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload; fi
echo "set-mac-worker: done. Restart bulig.service for it to take effect."
