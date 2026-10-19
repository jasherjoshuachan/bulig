#!/usr/bin/env bash
# Create the bulig system user and the folders Bulig uses. Idempotent: run it twice and the second run changes nothing.
# Run as root on ths-prod-01. It touches only the user "bulig" and the paths below.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
need_root

if id bulig >/dev/null 2>&1; then
  home="$(getent passwd bulig | cut -d: -f6)"
  [ "$home" = "$BULIG_HOME" ] || die "user bulig exists with home $home, not $BULIG_HOME. Not touching it."
  echo "user bulig: already there"
else
  # nologin on purpose: the service does not need a shell. Run one-off commands with: runuser -u bulig -- <command>
  useradd --system --home-dir "$BULIG_HOME" --create-home --shell /usr/sbin/nologin --user-group bulig
  echo "user bulig: created"
fi

# /var/lib/bulig: the service's own space (worktrees, state, ~/.claude, ~/.config/gh). The only place the service may write.
install -d -m 0750 -o bulig -g bulig "$BULIG_HOME" "$BULIG_HOME/worktrees" "$BULIG_HOME/state"
# Where the kernel looks for its config: $HOME/.bulig/config.json. Root owns the folder and the file, bulig can read but not edit them.
install -d -m 0750 -o root -g bulig "$BULIG_HOME/.bulig"
# /opt/bulig: releases are unpacked here. Root owns /opt/bulig; release.sh hands a release to bulig only while it installs packages.
install -d -m 0755 -o root -g root /opt/bulig /opt/bulig/releases
# /etc/bulig: root only. One secret per file, loaded by systemd LoadCredential=: pg-url, gh-token, claude-token, worker-tokens.
# Plus backup.env (R2 keys), loaded by the backup units only.
install -d -m 0700 -o root -g root /etc/bulig
# worker-tokens is filled by the worker protocol (PR-C). An empty file lets the unit start before that exists.
[ -e /etc/bulig/worker-tokens ] || install -m 0600 -o root -g root /dev/null /etc/bulig/worker-tokens
# Backups wait here before and after R2. Root only.
install -d -m 0700 -o root -g root /var/backups/bulig

# The service needs these on its PATH. Say what is missing now, not when the first job fails.
echo "tools the service will look for (as user bulig):"
missing=0
for tool in node pnpm git gh claude; do
  p="$(runuser -u bulig -- env PATH="/usr/local/bin:/usr/bin:/bin:$BULIG_HOME/.local/bin" bash -c "command -v $tool" 2>/dev/null || true)"
  if [ -n "$p" ]; then echo "  ok       $tool -> $p"; else echo "  MISSING  $tool"; missing=1; fi
done
nv="$(runuser -u bulig -- env PATH="/usr/local/bin:/usr/bin:/bin" node --version 2>/dev/null || true)"
case "$nv" in
  v22.* | v23.* | v24.* | v25.* | v26.*) echo "  ok       node $nv" ;;
  *) echo "  PROBLEM  node is '$nv', Bulig needs 22 or newer"; missing=1 ;;
esac
if [ "$missing" -ne 0 ]; then
  echo "Some tools are not visible to user bulig. Installed under /root or /home? Root-owned folders under /root and /home are not readable by bulig. Install them under /usr/local or $BULIG_HOME/.local." >&2
fi
echo "for the backup: $(command -v aws >/dev/null 2>&1 && echo 'aws cli found' || (command -v docker >/dev/null 2>&1 && echo 'no aws cli, docker found (the pinned aws-cli image will be used)') || echo 'NEITHER aws nor docker found: install one before enabling the backup timer')"
echo "setup-user: done"
exit 0
