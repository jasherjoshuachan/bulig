#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Native modules (better-sqlite3) are built for one Node major. Use the pinned one when fnm is installed.
if [[ -f .node-version ]] && command -v fnm >/dev/null; then
  eval "$(fnm env --shell bash)"
  fnm use --install-if-missing --silent-if-unchanged >/dev/null
fi

# The Postgres suites need initdb and pg_ctl, or BULIG_PG_TEST_URL. Homebrew keeps postgresql@16 off PATH, so point at it if it is there.
if [[ -z "${BULIG_PG_TEST_URL:-}" && -z "${BULIG_PG_BIN:-}" ]] && ! command -v initdb >/dev/null && [[ -d /opt/homebrew/opt/postgresql@16/bin ]]; then
  export BULIG_PG_BIN=/opt/homebrew/opt/postgresql@16/bin
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

# The Postgres suites skip where there is no Postgres. Say so. In CI a skip is a failure: the service container must be there.
if echo "$out" | grep -q 'Postgres suites skipped'; then
  if [[ -n "${CI:-}" ]]; then
    echo "verify: the Postgres suites were skipped in CI. Check the postgres service and BULIG_PG_TEST_URL." >&2
    exit 1
  fi
  echo "verify: note: the Postgres suites were skipped (no initdb and pg_ctl on PATH, no BULIG_PG_TEST_URL)."
fi

# Names that must never appear in this public repo. The list is private: see scripts/scan-forbidden.sh.
bash scripts/scan-forbidden.sh

# The deploy kit's own tests: path refusals, passfile format, and the before/after snapshot.
bash deploy/test/run.sh

echo "verify: ok"
