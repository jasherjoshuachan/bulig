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

# make_user <name>: the home is only RECORDED (useradd --home-dir, in /etc/passwd). No folder is created: systemd does that.
make_user() {
  local name="$1" home="/var/lib/$1" have
  if id "$name" >/dev/null 2>&1; then
    have="$(getent passwd "$name" | cut -d: -f6)"
    [ "$have" = "$home" ] || die "user $name exists with home $have, not $home. Not touching it."
    echo "user $name: already there"
  else
    # No home is created: systemd makes it (StateDirectory=) when the unit starts. nologin on purpose: neither service needs a shell.
    # One-off commands go through bulig-cli.sh, which runs them as a capped transient unit.
    useradd --system --no-create-home --home-dir "$home" --shell /usr/sbin/nologin --user-group "$name"
    echo "user $name: created (no home yet: systemd makes $home when the unit first starts)"
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
# Work areas for releases and the before/after snapshots. Root only.
ensure_checks_dir

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
