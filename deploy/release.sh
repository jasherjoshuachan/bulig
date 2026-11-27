#!/usr/bin/env bash
# Release a git ref of Bulig to bulig-host. Run from the Mac, inside the bulig checkout:
#   bash deploy/release.sh [ref]          (default: HEAD)
# What happens:
#   1. `git archive <sha>` is streamed over ssh into a fresh root-owned folder on the server, /var/lib/bulig-checks/incoming.XXXXXX
#      (unpacked by root, owned by root, in a root-owned parent). Nothing is written with rsync into a folder a Bulig user could own.
#   2. deploy/release-remote.sh, from that folder, runs as root and does the rest (see its header): dependency install as a throwaway
#      user in a transient unit, the final Node tree rebuilt from the delivered copy, the root tools and unit files installed, both
#      `current` links swapped, services restarted, health checked, everything put back on any failure.
# It touches only /var/lib/bulig-checks, /opt/bulig, /usr/local/lib/bulig, /etc/bulig, /etc/systemd/system/bulig*, and the two Bulig
# services. It never touches /var/lib/bulig or /var/lib/bulig-worker.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# The server, as your ssh alias (nothing is assumed: a hard-coded host name outlives the host). Set it per run or in your shell:
#   BULIG_DEPLOY_HOST=<alias> bash deploy/release.sh
# BULIG_DEPLOY_SUDO is for a server you log in to as a normal user: BULIG_DEPLOY_SUDO='sudo -n' runs the root steps through sudo.
# Left empty (the default) the ssh login must already be root.
HOST="${BULIG_DEPLOY_HOST:?release: set BULIG_DEPLOY_HOST to your ssh alias for the server, e.g. BULIG_DEPLOY_HOST=myserver bash deploy/release.sh}"
SUDO="${BULIG_DEPLOY_SUDO:-}"
KEEP="${BULIG_KEEP_RELEASES:-5}"
ref="${1:-HEAD}"

sha="$(git rev-parse --verify --quiet "$ref^{commit}")" || { echo "release: '$ref' is not a commit in this repo" >&2; exit 1; }
short="${sha:0:12}"
git cat-file -e "$sha:pnpm-lock.yaml" 2>/dev/null || { echo "release: $ref has no pnpm-lock.yaml" >&2; exit 1; }
git cat-file -e "$sha:deploy/release-remote.sh" 2>/dev/null || { echo "release: $ref has no deploy kit (deploy/release-remote.sh)" >&2; exit 1; }
echo "==> releasing $ref = $short to $HOST"

ssh "$HOST" "test -d /opt/bulig/releases && test -d /usr/local/lib/bulig && test -d /var/lib/bulig-checks && id bulig >/dev/null && id bulig-worker >/dev/null" \
  || { echo "release: /opt/bulig/releases, /usr/local/lib/bulig, /var/lib/bulig-checks or the bulig users are missing on $HOST. Run setup-user.sh first." >&2; exit 1; }

echo "==> stream the archive to $HOST"
# One private folder per run (mktemp -d makes it 0700, root's, nobody else's). tar --no-same-owner: whatever the archive says, root owns it.
remote_unpack='set -e; d=$(mktemp -d /var/lib/bulig-checks/incoming.XXXXXX); umask 022; tar -x --no-same-owner -f - -C "$d"; echo "$d"'
# shellcheck disable=SC2029 # $SUDO is meant to expand here: it is the operator's own setting
incoming="$(git archive --format=tar "$sha" | ssh "$HOST" "$SUDO bash -c $(printf '%q' "$remote_unpack")")"
[[ "$incoming" =~ ^/var/lib/bulig-checks/incoming\.[A-Za-z0-9]{6}$ ]] || { echo "release: odd answer from $HOST: $incoming" >&2; exit 1; }

echo "==> install, swap, restart, check (on $HOST)"
set +e
# shellcheck disable=SC2029,SC2086 # $incoming, $short and $KEEP are meant to expand here (checked above); $SUDO is words on purpose
ssh "$HOST" $SUDO bash "$incoming/deploy/release-remote.sh" "$short" "$KEEP"
rc=$?
set -e
if [ "$rc" -eq 3 ]; then echo "release: refused, $short is already live on $HOST" >&2; exit 3; fi
[ "$rc" -eq 0 ] || { echo "release: FAILED (see above)" >&2; exit "$rc"; }
echo "==> done: $short is live on $HOST"
