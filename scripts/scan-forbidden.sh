#!/usr/bin/env bash
# Scans tracked files for terms that must never appear in this public repo.
# The term list is not stored here. It comes from $BULIG_FORBIDDEN_TERMS (a regex),
# or the first line of ${XDG_CONFIG_HOME:-$HOME/.config}/bulig/forbidden-terms.
# On a hit it prints file:line only. Never the matched text, never the pattern.
set -uo pipefail
root="${SCAN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

pat="${BULIG_FORBIDDEN_TERMS:-}"
if [ -z "$pat" ]; then
  f="${XDG_CONFIG_HOME:-$HOME/.config}/bulig/forbidden-terms"
  if [ -r "$f" ]; then pat="$(head -n 1 "$f")"; fi
fi

if [ -z "$pat" ]; then
  if [ -n "${CI:-}" ]; then
    echo "verify: notice: forbidden-terms scan skipped (BULIG_FORBIDDEN_TERMS is not set)"
  else
    echo "verify: WARNING: forbidden-terms scan skipped. Set BULIG_FORBIDDEN_TERMS or create the bulig/forbidden-terms file in your config dir." >&2
  fi
  exit 0
fi

# An invalid regex is a failure, and grep's own message could echo the pattern, so say it ourselves.
printf '' | grep -E -e "$pat" >/dev/null 2>&1
if [ $? -eq 2 ]; then
  echo "verify: the forbidden-terms pattern is not a valid extended regex" >&2
  exit 1
fi

cd "$root" || exit 1
hits="$(git ls-files -z | xargs -0 grep -HInEi -e "$pat" 2>/dev/null | cut -d: -f1,2)"
if [ -n "$hits" ]; then
  echo "verify: forbidden terms found at (file:line):" >&2
  echo "$hits" >&2
  exit 1
fi
echo "verify: forbidden-terms scan clean"
