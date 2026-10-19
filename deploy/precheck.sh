#!/usr/bin/env bash
# Take the "before" picture of ths-prod-01, so postcheck.sh can prove Bulig changed nothing that is not Bulig's.
# Read-only: it runs list commands and writes one file under /var/lib/bulig-checks. Run as root, before setup-user.sh.
# usage: precheck.sh [output-file]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
# shellcheck source=lib/snapshot.sh
. "$here/lib/snapshot.sh"
need_root

dir=/var/lib/bulig-checks
out="${1:-$dir/precheck.snapshot}"
install -d -m 0700 "$(dirname "$out")"
tmp="$(mktemp "$out.XXXXXX")"
snapshot >"$tmp"
mv "$tmp" "$out"
chmod 600 "$out"
echo "precheck: saved $(wc -l <"$out") lines to $out"
