#!/usr/bin/env bash
# The "after" picture: compare ths-prod-01 to the precheck and fail on any difference in what the snapshot covers (see lib/snapshot.sh),
# apart from Bulig's own users, units, cluster and folders. Read-only except for temp files in /var/lib/bulig-checks.
# Not compared, only reported (see snapshot_compare in lib/snapshot.sh): the run state of services a timer starts (a "failed" one is a warn
# line that names it), and containers that come and go while their image keeps running. Unit files, enabled state and timers still are.
# It does NOT prove anything it does not list: files outside the snapshot, data inside other databases, and live behaviour are not checked.
# No arguments: it compares against /var/lib/bulig-checks/precheck.snapshot.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
# shellcheck source=lib/snapshot.sh
. "$here/lib/snapshot.sh"
need_root
[ "$#" -eq 0 ] || die "takes no arguments: it reads only $BULIG_CHECKS_DIR/precheck.snapshot"

before="$BULIG_CHECKS_DIR/precheck.snapshot"
[ -r "$before" ] || die "no precheck file at $before. Run precheck.sh before anything else."
need_dir "$BULIG_CHECKS_DIR"
after="$(mktemp "$BULIG_CHECKS_DIR/postcheck.XXXXXX")"
trap 'rm -f "$after" "$after.before" "$after.after" "$after.diff"' EXIT
snapshot >"$after"
snapshot_compare "$before" "$after" "$after.before" "$after.after"

if diff -u --label precheck --label postcheck "$after.before" "$after.after" >"$after.diff"; then
  echo "postcheck: the snapshot matches the precheck (apart from Bulig's own things, and anything listed above as info or warn)"
  rc=0
else
  echo "postcheck: FAILED. Something the snapshot covers changed, and it is not Bulig's:"
  cat "$after.diff"
  rc=1
fi
exit "$rc"
