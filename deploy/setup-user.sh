#!/usr/bin/env bash
# Create the two Bulig system users and the folders Bulig uses. Idempotent: a second run changes nothing.
# Run as root on ths-prod-01. It touches only the users bulig and bulig-worker and the paths below.
#
#   bulig         the kernel (bulig.service). Holds the database URL, the GitHub token, the worker tokens. Never sees the Claude token.
#   bulig-worker  the worker (bulig-worker.service). Runs Claude Code. Holds the Claude token and its own worker token. Never sees
#                 /etc/bulig or the kernel's credentials: they are different users with different units.
#
# The two users share no folder and no group. The worker has its own clone of a repo and sends the kernel a patch; the kernel applies it in
# its own worktree (ADR 0011, PR #50). Neither user can read the other's tree.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
need_root

make_user() {
  local name="$1" home="$2" have
  if id "$name" >/dev/null 2>&1; then
    have="$(getent passwd "$name" | cut -d: -f6)"
    [ "$have" = "$home" ] || die "user $name exists with home $have, not $home. Not touching it."
    echo "user $name: already there"
  else
    # nologin on purpose: neither service needs a shell. One-off commands: runuser -u <user> -- <command>
    useradd --system --home-dir "$home" --create-home --shell /usr/sbin/nologin --user-group "$name"
    echo "user $name: created"
  fi
}

make_user bulig "$BULIG_HOME"
make_user bulig-worker "$BULIG_WORKER_HOME"

# /var/lib/bulig (the kernel's space) and /var/lib/bulig-worker (the worker's) are each 0700 and owned by their own user. See setup_folders in lib/common.sh.
setup_folders
# git's "dubious ownership" check does not fire: each user only opens repos it created itself, so no safe.directory entry is added.
# If one is ever needed, add that exact path for that user only, never '*'.

# /opt/bulig: releases are unpacked here. Root owns /opt/bulig; release.sh hands a release to bulig only while it installs packages.
install -d -m 0755 -o root -g root /opt/bulig /opt/bulig/releases
# /etc/bulig: root only. One secret per file (see credentials.example), loaded by systemd LoadCredential= into the unit that needs it.
install -d -m 0700 -o root -g root /etc/bulig
# worker-tokens (kernel side) and worker-token (worker side) are filled by the worker protocol (PR-C). Empty files let the units start before that exists.
for f in worker-tokens worker-token; do
  [ -e "/etc/bulig/$f" ] || install -m 0600 -o root -g root /dev/null "/etc/bulig/$f"
done
# Backups wait here before and after R2, and the index of what was backed up lives here. Root only.
install -d -m 0700 -o root -g root /var/backups/bulig

check_tools() {
  local user="$1" home="$2" tool p nv bad=0
  shift 2
  echo "tools $user will look for:"
  for tool in "$@"; do
    p="$(runuser -u "$user" -- env HOME="$home" PATH="/usr/local/bin:/usr/bin:/bin:$home/.local/bin" bash -c "command -v $tool" 2>/dev/null || true)"
    if [ -n "$p" ]; then echo "  ok       $tool -> $p"; else echo "  MISSING  $tool"; bad=1; fi
  done
  nv="$(runuser -u "$user" -- env HOME="$home" PATH="/usr/local/bin:/usr/bin:/bin" node --version 2>/dev/null || true)"
  case "$nv" in
    v22.* | v23.* | v24.* | v25.* | v26.*) echo "  ok       node $nv" ;;
    *) echo "  PROBLEM  node is '$nv', Bulig needs 22 or newer"; bad=1 ;;
  esac
  return "$bad"
}
missing=0
check_tools bulig "$BULIG_HOME" node pnpm git gh || missing=1
check_tools bulig-worker "$BULIG_WORKER_HOME" node git claude || missing=1
if [ "$missing" -ne 0 ]; then
  echo "Some tools are not visible to those users. Installed under /root or /home? Install them under /usr/local or the user's ~/.local." >&2
fi
echo "for the backup: $(command -v aws >/dev/null 2>&1 && echo 'aws cli found' || (command -v docker >/dev/null 2>&1 && echo 'no aws cli, docker found (the pinned aws-cli image will be used)') || echo 'NEITHER aws nor docker found: install one before enabling the backup timer')"
echo "setup-user: done"
exit 0
