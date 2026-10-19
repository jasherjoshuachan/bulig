# shellcheck shell=bash disable=SC2034
# Shared by the test scripts in this folder. Source it; do not run it.
# Counts passes and failures, and gives the expect_* helpers. Each suite ends with `finish`.
# No test may wait on a terminal: a refusal that falls through to reading stdin must fail, not hang.
exec </dev/null
here="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
deploy="$(dirname "$here")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
pass=0
fail=0

ok() { pass=$((pass + 1)); echo "  ok    $1"; }
bad() { fail=$((fail + 1)); echo "  FAIL  $1"; }
expect_ok() {
  local label="$1"
  shift
  if "$@" >"$work/out" 2>&1; then ok "$label"; else bad "$label: $(head -c 300 "$work/out")"; fi
}
expect_fail() {
  local label="$1"
  shift
  if "$@" >"$work/out" 2>&1; then bad "$label (it succeeded)"; else ok "$label"; fi
}
# expect_fail_msg <label> <text the output must contain> <command...>: the command must fail AND say why. A refusal that fails for another
# reason (a missing folder, a typo in the test) does not count.
expect_fail_msg() {
  local label="$1" want="$2"
  shift 2
  if "$@" >"$work/out" 2>&1; then bad "$label (it succeeded)"; elif grep -qF -- "$want" "$work/out"; then ok "$label"; else bad "$label (failed, but not with '$want'): $(head -c 300 "$work/out")"; fi
}
mode() { if /usr/bin/stat -c %a "$1" >/dev/null 2>&1; then /usr/bin/stat -c %a "$1"; else /usr/bin/stat -f %Lp "$1"; fi; }
finish() {
  echo
  echo "passed $pass, failed $fail"
  [ "$fail" -eq 0 ]
}
