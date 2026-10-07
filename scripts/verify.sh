#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Native modules (better-sqlite3) are built for one Node major. Use the pinned one when fnm is installed.
if [[ -f .node-version ]] && command -v fnm >/dev/null; then
  eval "$(fnm env --shell bash)"
  fnm use --install-if-missing --silent-if-unchanged >/dev/null
fi

pnpm install --frozen-lockfile
pnpm typecheck

if ! out="$(pnpm test 2>&1)"; then
  echo "$out"
  echo "verify: tests failed" >&2
  exit 1
fi
echo "$out"
# A run that executed nothing is a failure, not a pass.
if ! echo "$out" | grep -Eq 'Tests +.*[1-9][0-9]* passed'; then
  echo "verify: vitest reported no passing tests" >&2
  exit 1
fi

# Names that must never appear in this public repo. The list is private: see scripts/scan-forbidden.sh.
bash scripts/scan-forbidden.sh

echo "verify: ok"
