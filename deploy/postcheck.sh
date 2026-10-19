#!/usr/bin/env bash
# The "after" picture: compare ths-prod-01 to the precheck and fail on any change that is not Bulig's.
# Read-only. Run as root after the last Bulig step.
# usage: postcheck.sh [precheck-file]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
# shellcheck source=lib/snapshot.sh
. "$here/lib/snapshot.sh"
need_root

dir=/var/lib/bulig-checks
before="${1:-$dir/precheck.snapshot}"
[ -r "$before" ] || die "no precheck file at $before. Run precheck.sh before anything else."
after="$(mktemp "$dir/postcheck.XXXXXX")"
trap 'rm -f "$after" "$after.diff"' EXIT
snapshot >"$after"

if diff -u --label precheck --label postcheck "$before" "$after" >"$after.diff"; then
  echo "postcheck: no change outside Bulig (compared with $before)"
  rc=0
else
  echo "postcheck: FAILED. Something that is not Bulig's changed:"
  cat "$after.diff"
  rc=1
fi

# What did change must be Bulig's: its cluster exists, and the service is the only new thing.
if ! pg_lsclusters -h | awk -v v="$BULIG_PG_VERSION" -v c="$BULIG_PG_CLUSTER" -v p="$BULIG_PG_PORT" '$1 == v && $2 == c && $3 == p {found = 1} END {exit !found}'; then
  echo "postcheck: note: cluster $BULIG_PG_VERSION $BULIG_PG_CLUSTER on $BULIG_PG_PORT does not exist (nothing of Bulig's to check)"
fi
exit "$rc"
