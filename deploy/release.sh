#!/usr/bin/env bash
# Release a git ref of Bulig to ths-prod-01. Run from the Mac, inside the bulig checkout:
#   bash deploy/release.sh [ref]          (default: HEAD)
# What happens (the server half is deploy/release-remote.sh, sent over ssh and run as root, so it is always the one in your checkout):
#   1. git archive of the ref -> two trees, both root-owned on arrival:
#        Node code  -> /opt/bulig/releases/<sha>       (run as bulig and bulig-worker)
#        deploy/    -> /usr/local/lib/bulig/<sha>      (run as ROOT: health, backup, drill, checks; plus the unit files)
#      Nothing root runs ever lives in a tree bulig owned.
#   2. the dependency install runs on a copy, as a transient capped unit; the final Node tree is rebuilt from the delivered copy plus the
#      node_modules folders, so a build script cannot change a file or keep a handle into the live release.
#   3. both `current` symlinks and the unit files are swapped, the services restarted, health checked; any failure puts all three back.
# It touches only /opt/bulig, /usr/local/lib/bulig, /etc/systemd/system/bulig*, and the two Bulig services.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

HOST="${BULIG_DEPLOY_HOST:-ths-prod-01}"
KEEP="${BULIG_KEEP_RELEASES:-5}"
ref="${1:-HEAD}"

sha="$(git rev-parse --verify --quiet "$ref^{commit}")" || { echo "release: '$ref' is not a commit in this repo" >&2; exit 1; }
short="${sha:0:12}"
echo "==> releasing $ref = $short to $HOST"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
git archive --format=tar "$sha" | tar -x -C "$stage"
[ -f "$stage/pnpm-lock.yaml" ] || { echo "release: the archive has no pnpm-lock.yaml" >&2; exit 1; }
[ -x "$stage/deploy/health.sh" ] || { echo "release: ref $ref has no deploy kit (deploy/health.sh)" >&2; exit 1; }

ssh "$HOST" "test -d /opt/bulig/releases && test -d /usr/local/lib/bulig && id bulig >/dev/null && id bulig-worker >/dev/null" \
  || { echo "release: /opt/bulig/releases, /usr/local/lib/bulig or the bulig users are missing on $HOST. Run setup-user.sh first." >&2; exit 1; }

# One private name per run, so two releases of the same sha cannot write into each other. The server renames the folders into place under a lock.
name=".incoming-$short-$$"
echo "==> rsync to $HOST ($name)"
rsync -az --delete --exclude=/deploy "$stage/" "$HOST:/opt/bulig/releases/$name/"
rsync -az --delete "$stage/deploy/" "$HOST:/usr/local/lib/bulig/$name/"

echo "==> install, swap, restart, check (on $HOST)"
set +e
ssh "$HOST" bash -s -- "$short" "$KEEP" "$name" <"$stage/deploy/release-remote.sh"
rc=$?
set -e
if [ "$rc" -eq 3 ]; then echo "release: refused, $short is already live on $HOST" >&2; exit 3; fi
[ "$rc" -eq 0 ] || { echo "release: FAILED (see above)" >&2; exit "$rc"; }
echo "==> done: $short is live on $HOST"
