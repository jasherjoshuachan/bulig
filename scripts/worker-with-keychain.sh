#!/usr/bin/env bash
# Start `bulig worker` with the kernel token taken from the macOS Keychain.
# Usage: scripts/worker-with-keychain.sh <workerId> --kernel <url> --repo <kernelPath>=<localClone> [more bulig worker flags]
# The token goes into this process's environment only. It is never printed or written to a file, and the worker does not hand it to Claude.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -lt 1 || "$1" == -* ]]; then
  echo "usage: worker-with-keychain.sh <workerId> [bulig worker flags]" >&2
  exit 2
fi
id="$1"
shift
if [[ ! "$id" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]]; then
  echo "worker-with-keychain: the worker id must be lowercase letters, digits, - or _." >&2
  exit 2
fi

# The database module is built for one Node major. Use the pinned one when fnm is installed.
if [[ -f .node-version ]] && command -v fnm >/dev/null; then
  if ! fnm_env="$(fnm env --shell bash)"; then
    echo "worker-with-keychain: 'fnm env' failed, so the pinned Node version could not be set up." >&2
    exit 1
  fi
  eval "$fnm_env"
  fnm use --install-if-missing --silent-if-unchanged >/dev/null
fi

item="bulig-worker-token-${id}"
if ! BULIG_WORKER_TOKEN="$(security find-generic-password -s "$item" -w 2>/dev/null)" || [ -z "$BULIG_WORKER_TOKEN" ]; then
  echo "worker-with-keychain: no Keychain item named ${item}." >&2
  echo "Add it with: security add-generic-password -U -s ${item} -a bulig -w" >&2
  exit 1
fi
export BULIG_WORKER_TOKEN

# Claude Code uses its own sign-in.
exec pnpm bulig worker --id "$id" --token-env BULIG_WORKER_TOKEN "$@"
