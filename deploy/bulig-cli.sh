#!/usr/bin/env bash
# Run one bulig CLI command on the server as a capped, hardened transient systemd unit. Never as a bare shell command.
#   usage (as root):  deploy/bulig-cli.sh [--as kernel|worker] <bulig arguments...>
#   --as kernel (default)  user bulig,        credentials pg-url, gh-token, worker-tokens   (what bulig.service has)
#   --as worker            user bulig-worker, credentials claude-token, worker-token        (what bulig-worker.service has)
# Same user, same credentials, same hardening and the same style of caps as the matching service (smaller numbers, so a one-off
# command cannot take the room the services need). The kernel reads its secrets from $CREDENTIALS_DIRECTORY, as in the unit.
# Only one writer may hold the database: stop bulig.service first for commands that write (run, resume, migrate), start it after.
# Read-only commands (status, history) can run while the service is up.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
need_root

role=kernel
if [ "${1:-}" = "--as" ]; then
  role="${2:-}"
  shift 2 || die "usage: bulig-cli.sh [--as kernel|worker] <bulig arguments...>"
fi
[ "$#" -gt 0 ] || die "usage: bulig-cli.sh [--as kernel|worker] <bulig arguments...>"
command -v systemd-run >/dev/null 2>&1 || die "systemd-run not found"

common=(
  -p NoNewPrivileges=yes -p CapabilityBoundingSet= -p PrivateTmp=yes -p PrivateDevices=yes
  -p ProtectSystem=strict -p ProtectHome=read-only -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectKernelLogs=yes
  -p ProtectControlGroups=yes -p ProtectClock=yes -p ProtectHostname=yes -p ProtectProc=invisible
  -p RestrictSUIDSGID=yes -p RestrictRealtime=yes -p LockPersonality=yes -p SystemCallArchitectures=native
  -p RestrictAddressFamilies="AF_UNIX AF_INET AF_INET6"
  -p UMask=0077
  -p TasksMax=256 -p CPUWeight=50 -p Nice=10
)
case "$role" in
  kernel)
    spec=(--uid=bulig --gid=bulig -p MemoryMax=2G -p CPUQuota=200% -p ReadWritePaths="$BULIG_HOME"
      -p LoadCredential=pg-url:/etc/bulig/pg-url -p LoadCredential=gh-token:/etc/bulig/gh-token -p LoadCredential=worker-tokens:/etc/bulig/worker-tokens
      --setenv=HOME="$BULIG_HOME" --setenv=PATH="/usr/local/bin:/usr/bin:/bin:$BULIG_HOME/.local/bin") ;;
  worker)
    spec=(--uid=bulig-worker --gid=bulig-worker -p MemoryMax=2G -p CPUQuota=200% -p ReadWritePaths="$BULIG_WORKER_HOME"
      -p LoadCredential=claude-token:/etc/bulig/claude-token -p LoadCredential=worker-token:/etc/bulig/worker-token
      --setenv=HOME="$BULIG_WORKER_HOME" --setenv=PATH="/usr/local/bin:/usr/bin:/bin:$BULIG_WORKER_HOME/.local/bin") ;;
  *) die "--as must be kernel or worker" ;;
esac

# --pipe --wait: stdin/stdout go through, the exit status comes back, the unit is removed afterwards.
exec systemd-run --quiet --pipe --wait --collect --working-directory=/opt/bulig/current \
  "${spec[@]}" "${common[@]}" -- /usr/bin/env node packages/cli/bin/bulig.mjs "$@"
