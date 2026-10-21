#!/usr/bin/env bash
# The "after" picture: compare ths-prod-01 to a "before" snapshot and fail on any difference in what the snapshot covers (see lib/snapshot.sh),
# apart from Bulig's own users, units, cluster and folders. Read-only except for temp files in /var/lib/bulig-checks.
# Not compared, only reported (see snapshot_compare in lib/snapshot.sh): the run state of services a timer starts, transient systemd-run units,
# template instances that came or went (a "failed" one of any of those is a warn line that names it), and containers that come and go while
# their image keeps running. Unit files, enabled state and timers still are.
# It does NOT prove anything it does not list: files outside the snapshot, data inside other databases, and live behaviour are not checked.
#   usage: postcheck.sh                       against the newest release-<sha>.before.snapshot in /var/lib/bulig-checks (each release
#                                             takes one just before it changes anything), or precheck.snapshot when there is none
#          postcheck.sh --against <snapshot>  against that file (precheck.snapshot for the removal check in the RUNBOOK)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
# shellcheck source=lib/snapshot.sh
. "$here/lib/snapshot.sh"
need_root

if [ "$#" -eq 0 ]; then
  newest="$(snapshot_release_files | head -1)"
  if [ -n "$newest" ]; then before="$BULIG_CHECKS_DIR/$newest"; else before="$BULIG_CHECKS_DIR/precheck.snapshot"; fi
elif [ "$#" -eq 2 ] && [ "$1" = "--against" ] && [ -n "$2" ]; then
  before="$2"
else
  die "usage: postcheck.sh [--against <snapshot file>] (no arguments: the newest release-<sha>.before.snapshot, else precheck.snapshot)"
fi
[ -f "$before" ] && [ -r "$before" ] || die "no snapshot file at $before. Run precheck.sh before anything else (a release takes its own)."
need_dir "$BULIG_CHECKS_DIR"
name="$(basename "$before")"
echo "postcheck: comparing against $before"
after="$(mktemp "$BULIG_CHECKS_DIR/postcheck.XXXXXX")"
trap 'rm -f "$after" "$after.before" "$after.after" "$after.diff"' EXIT
snapshot >"$after"
snapshot_compare "$before" "$after" "$after.before" "$after.after"

if diff -u --label "$name" --label postcheck "$after.before" "$after.after" >"$after.diff"; then
  echo "postcheck: the snapshot matches $name (apart from Bulig's own things, and anything listed above as info or warn)"
  rc=0
else
  echo "postcheck: FAILED. Something the snapshot covers changed since $name, and it is not Bulig's:"
  cat "$after.diff"
  rc=1
fi
exit "$rc"
