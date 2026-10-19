#!/usr/bin/env bash
# Create the two Bulig system users and the root-owned folders the kit uses. Idempotent: a second run changes nothing.
# Run as root on ths-prod-01, with both Bulig services stopped (it refuses while any process of either user exists).
#
#   bulig         the kernel (bulig.service). Holds the database URL, the GitHub token, the worker tokens. Never sees the Claude token.
#   bulig-worker  the worker (bulig-worker.service). Runs Claude Code. Holds the Claude token and its own worker token. Never sees
#                 /etc/bulig or the kernel's credentials: they are different users with different units.
#
# THE INVARIANT: this script creates NO folder for either user. /var/lib/bulig and /var/lib/bulig-worker (their homes) are made, owned and
# re-owned only by systemd, from StateDirectory= in the two units. The users are made with --no-create-home for that reason. Everything
# below is a root-owned folder under a root-owned parent.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
need_root
refuse_if_users_running

# make_user <name>: an existing user is left alone. Its passwd home does not matter (the units set HOME and StateDirectory= themselves),
# and a root script does not look the home up. A new user is made with the home only RECORDED (--home-dir, in /etc/passwd); no folder is
# created: systemd does that when the unit starts.
make_user() {
  local name="$1"
  if id "$name" >/dev/null 2>&1; then
    echo "user $name: already there"
  else
    # nologin on purpose: neither service needs a shell. One-off commands go through bulig-cli.sh (a capped transient unit).
    useradd --system --no-create-home --home-dir "/var/lib/$name" --shell /usr/sbin/nologin --user-group "$name"
    echo "user $name: created (no home yet: systemd makes /var/lib/$name when the unit first starts)"
  fi
}

make_user bulig
make_user bulig-worker

# /opt/bulig: the Node code, one folder per release. Root's, read-only to both services.
root_dir 0755 "$BULIG_OPT_DIR"
root_dir 0755 "$BULIG_OPT_DIR/releases"
# /usr/local/lib/bulig: the scripts ROOT runs (health, backup, drill, checks) and the unit files. Installed by release.sh from the delivered
# copy. Units run from /usr/local/lib/bulig/current.
root_dir 0755 "$BULIG_TOOLS_DIR"
# /etc/bulig: root only. One secret per file (see credentials.example), loaded by systemd LoadCredential= into the unit that needs it.
root_dir 0700 "$BULIG_CRED_DIR"
# Backups wait here before and after R2, and the index of what was backed up lives here. Root only.
root_dir 0700 "$BULIG_BACKUP_DIR"
# Work areas for releases and the before/after snapshots. Root only. docker/ is the docker client's config folder for the backup units
# (DOCKER_CONFIG), so docker never looks in /root, which those units cannot see.
ensure_checks_dir
root_dir 0700 "$BULIG_CHECKS_DIR/docker"

# Tools must be in system folders: neither user has a home with a ~/.local, and the dependency build runs as a throwaway user.
check_tools() {
  local user="$1" tool p nv bad=0
  shift
  echo "tools $user will look for:"
  for tool in "$@"; do
    p="$(runuser -u "$user" -- env HOME=/nonexistent PATH="/usr/local/bin:/usr/bin:/bin" bash -c "command -v $tool" 2>/dev/null || true)"
    if [ -n "$p" ]; then echo "  ok       $tool -> $p"; else echo "  MISSING  $tool"; bad=1; fi
  done
  nv="$(runuser -u "$user" -- env HOME=/nonexistent PATH="/usr/local/bin:/usr/bin:/bin" node --version 2>/dev/null || true)"
  case "$nv" in
    v22.* | v23.* | v24.* | v25.* | v26.*) echo "  ok       node $nv" ;;
    *) echo "  PROBLEM  node is '$nv', Bulig needs 22 or newer"; bad=1 ;;
  esac
  return "$bad"
}
missing=0
check_tools bulig node pnpm git gh || missing=1
check_tools bulig-worker node git claude || missing=1
if [ "$missing" -ne 0 ]; then
  echo "Some tools are not visible to those users. Install them under /usr/local or /usr, not under /root or /home." >&2
fi
echo "for the backup: $(command -v aws >/dev/null 2>&1 && echo 'aws cli found' || (command -v docker >/dev/null 2>&1 && echo 'no aws cli, docker found (the pinned aws-cli image will be used)') || echo 'NEITHER aws nor docker found: install one before enabling the backup timer')"
echo "setup-user: done"
exit 0
