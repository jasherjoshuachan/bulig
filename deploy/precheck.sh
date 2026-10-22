#!/usr/bin/env bash
# Take the "before" picture of ths-prod-01, so postcheck.sh can prove Bulig changed nothing that is not Bulig's.
# Read-only except for one file: /var/lib/bulig-checks/precheck.snapshot (Bulig's own folder). No arguments, no other path.
# Run as root, before setup-user.sh (it makes the root-owned /var/lib/bulig-checks if it is not there). Every release later takes its own
# "before" picture (release-<sha>.before.snapshot, lib/snapshot.sh); this one stays as the baseline for removing Bulig.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
# shellcheck source=lib/snapshot.sh
. "$here/lib/snapshot.sh"
need_root
[ "$#" -eq 0 ] || die "takes no arguments: it writes only to $BULIG_CHECKS_DIR"

ensure_checks_dir
out="$BULIG_CHECKS_DIR/precheck.snapshot"
trap '[ -z "${SNAPSHOT_TMP:-}" ] || rm -f "$SNAPSHOT_TMP"' EXIT
snapshot_save "$out"
echo "precheck: saved $(wc -l <"$out") lines to $out"
