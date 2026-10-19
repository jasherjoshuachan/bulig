#!/usr/bin/env bash
# Run one command on the server as a Bulig user, as a capped, hardened transient systemd unit. Never as a bare shell command, and never
# with root touching anything inside the user's folder: systemd makes and owns that folder (StateDirectory=), the command runs as the user.
#   usage (as root):  deploy/bulig-cli.sh [--as kernel|worker] <bulig arguments...>
#                     deploy/bulig-cli.sh [--as kernel|worker] --exec <program> <arguments...>
#                     deploy/bulig-cli.sh [--as kernel|worker] --tty --exec <program> ...     (a terminal, for claude setup-token: ssh -t)
#   --as kernel (default)  user bulig,        credentials config, pg-url, gh-token, worker-tokens   (what bulig.service has)
#   --as worker            user bulig-worker, credentials claude-token, worker-token, github-read-token  (what bulig-worker.service has)
#   --exec                 run <program> (for example git clone, for a repo the worker needs) instead of the bulig CLI
# Same user, same credentials, same hardening, same network and socket fence (lib/common.sh: IP filter, address families, hidden sockets, resolver) and the same style of caps as the matching service (smaller numbers, so a one-off
# command cannot take the room the services need). The kernel reads its secrets from $CREDENTIALS_DIRECTORY, as in the unit.
# Only one writer may hold the database: stop bulig.service first for commands that write (run, resume, migrate), start it after.
# Read-only commands (status, history) can run while the service is up.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
need_root

role=kernel
usage="usage: bulig-cli.sh [--as kernel|worker] [--tty] (<bulig arguments...> | --exec <program> <arguments...>)"
if [ "${1:-}" = "--as" ]; then
  role="${2:-}"
  shift 2 || die "$usage"
fi
io_flag=--pipe
if [ "${1:-}" = "--tty" ]; then
  io_flag=--pty
  shift
fi
exec_mode=0
if [ "${1:-}" = "--exec" ]; then
  exec_mode=1
  shift
fi
[ "$#" -gt 0 ] || die "$usage"
command -v systemd-run >/dev/null 2>&1 || die "systemd-run not found"

common=(
  -p NoNewPrivileges=yes -p CapabilityBoundingSet= -p PrivateTmp=yes -p PrivateDevices=yes
  -p ProtectSystem=strict -p ProtectHome=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectKernelLogs=yes
  -p ProtectControlGroups=yes -p ProtectClock=yes -p ProtectHostname=yes -p ProtectProc=invisible
  -p RestrictSUIDSGID=yes -p RestrictRealtime=yes -p LockPersonality=yes -p SystemCallArchitectures=native
  -p UMask=0077 -p StateDirectoryMode=0700
  -p KillMode=control-group
  -p TasksMax=256 -p CPUWeight=50 -p Nice=10
)
# creds <name:file> ...: a -p LoadCredential= for each credential file that exists. A file that is not there yet (the Claude token, before
# `claude setup-token` has run) is left out with a note, so the command that makes it can run.
creds=()
add_creds() {
  local pair name file
  for pair in "$@"; do
    name="${pair%%:*}"
    file="${pair#*:}"
    if [ -e "$BULIG_CRED_DIR/$file" ]; then creds+=(-p "LoadCredential=$name:$BULIG_CRED_DIR/$file"); else echo "bulig-cli: note: $BULIG_CRED_DIR/$file does not exist, so credential $name is not loaded" >&2; fi
  done
}
case "$role" in
  kernel)
    cli_fence_props kernel
    add_creds config:config.json pg-url:pg-url gh-token:gh-token worker-tokens:worker-tokens
    spec=(--uid=bulig --gid=bulig --unit="bulig-cli-kernel-$$" -p MemoryMax=1G -p CPUQuota=100% -p StateDirectory=bulig
      --setenv=HOME=/var/lib/bulig --setenv=PATH="/usr/local/bin:/usr/bin:/bin") ;;
  worker)
    cli_fence_props worker
    add_creds claude-token:claude-token worker-token:worker-token github-read-token:github-read-token
    spec=(--uid=bulig-worker --gid=bulig-worker --unit="bulig-cli-worker-$$" -p MemoryMax=2G -p CPUQuota=200% -p StateDirectory=bulig-worker
      --setenv=HOME=/var/lib/bulig-worker --setenv=PATH="/usr/local/bin:/usr/bin:/bin") ;;
  *) die "--as must be kernel or worker" ;;
esac

# --pipe (or --pty) --wait: stdin/stdout go through, the exit status comes back, the unit is removed afterwards.
if [ "$exec_mode" -eq 1 ]; then
  exec systemd-run --quiet "$io_flag" --wait --collect --working-directory=/ "${spec[@]}" "${FENCE_CLI[@]}" "${creds[@]}" "${common[@]}" -- "$@"
fi
exec systemd-run --quiet "$io_flag" --wait --collect --working-directory=/opt/bulig/current "${spec[@]}" "${FENCE_CLI[@]}" "${creds[@]}" "${common[@]}" \
  -- /usr/bin/node /opt/bulig/current/packages/cli/bin/bulig.mjs "$@"
