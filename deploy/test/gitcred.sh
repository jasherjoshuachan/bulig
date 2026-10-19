#!/usr/bin/env bash
# Tests for git-credential-bulig-read: the credential helper that hands git a token from the unit's $CREDENTIALS_DIRECTORY at the moment git
# asks. It must print the two lines git wants and nothing else, never echo the token anywhere else, and answer only for https://github.com.
# The token below is made up. Nothing here talks to a network.
# shellcheck disable=SC1091,SC2030,SC2031,SC2154
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

helper="$deploy/git-credential-bulig-read"
creds="$work/creds"
mkdir -p "$creds"
tok="github_pat_TESTONLY0123456789_abcdefghij"
printf '%s\n' "$tok" >"$creds/github-read-token"
printf '%s\n' "ghs_KERNELONLY0123456789" >"$creds/gh-token"
ask='protocol=https
host=github.com

'
# run_helper <credential name> <operation> <stdin>: stdout to out, stderr to err, exit code in rc
run_helper() {
  rc=0
  printf '%s' "$3" | env -i PATH=/usr/bin:/bin CREDENTIALS_DIRECTORY="$creds" bash "$helper" "$1" "$2" >"$work/hout" 2>"$work/herr" || rc=$?
}

echo "git-credential-bulig-read"
if [ -x "$helper" ]; then ok "the helper is an executable file in the release tree"; else bad "the helper is not executable"; fi
run_helper github-read-token get "$ask"
if [ "$rc" = "0" ] && [ "$(cat "$work/hout")" = "username=x-access-token
password=$tok" ]; then ok "get prints username=x-access-token and password=<token>, and nothing else"; else bad "get output (rc $rc): $(cat "$work/hout")"; fi
if [ "$(wc -l <"$work/hout" | tr -d ' ')" = "2" ]; then ok "exactly two lines"; else bad "line count: $(wc -l <"$work/hout")"; fi
if [ ! -s "$work/herr" ]; then ok "nothing on stderr when it works"; else bad "stderr: $(cat "$work/herr")"; fi
run_helper gh-token get "$ask"
if [ "$(cat "$work/hout")" = "username=x-access-token
password=ghs_KERNELONLY0123456789" ]; then ok "the kernel's helper reads gh-token the same way"; else bad "gh-token output: $(cat "$work/hout")"; fi

echo "it answers only when it should"
run_helper github-read-token get 'protocol=https
host=example.invalid

'
if [ "$rc" = "0" ] && [ ! -s "$work/hout" ]; then ok "another host gets nothing"; else bad "other host (rc $rc): $(cat "$work/hout")"; fi
run_helper github-read-token get 'protocol=http
host=github.com

'
if [ ! -s "$work/hout" ]; then ok "plain http gets nothing"; else bad "http: $(cat "$work/hout")"; fi
run_helper github-read-token get ''
if [ ! -s "$work/hout" ]; then ok "an empty request gets nothing"; else bad "empty request: $(cat "$work/hout")"; fi
for op in store erase; do
  run_helper github-read-token "$op" "$ask"
  if [ "$rc" = "0" ] && [ ! -s "$work/hout" ] && [ ! -s "$work/herr" ]; then ok "$op does nothing (git must not keep the token)"; else bad "$op (rc $rc): $(cat "$work/hout" "$work/herr")"; fi
done
run_helper "../../etc/passwd" get "$ask"
if [ "$rc" = "2" ] && [ ! -s "$work/hout" ] && grep -q usage "$work/herr"; then ok "a credential name that is not on the list is refused"; else bad "bad name (rc $rc): $(cat "$work/hout" "$work/herr")"; fi
run_helper claude-token get "$ask"
if [ "$rc" = "2" ] && [ ! -s "$work/hout" ]; then ok "the Claude token is not on the list either"; else bad "claude-token (rc $rc): $(cat "$work/hout")"; fi
rc=0
printf '%s' "$ask" | env -i PATH=/usr/bin:/bin bash "$helper" github-read-token get >"$work/hout" 2>"$work/herr" || rc=$?
if [ "$rc" = "0" ] && [ ! -s "$work/hout" ] && grep -q "not loaded" "$work/herr"; then ok "with no credentials folder it prints nothing and says so on stderr"; else bad "no folder (rc $rc): $(cat "$work/hout" "$work/herr")"; fi
rm "$creds/github-read-token"
run_helper github-read-token get "$ask"
if [ ! -s "$work/hout" ] && grep -q "not loaded" "$work/herr"; then ok "a missing credential file prints nothing and says so on stderr"; else bad "missing file: $(cat "$work/hout" "$work/herr")"; fi

echo "the token never leaves by another route"
bad_token="not a token $tok"
printf '%s\n' "$bad_token" >"$creds/github-read-token"
run_helper github-read-token get "$ask"
if [ ! -s "$work/hout" ]; then ok "a file that is not a plain token prints nothing"; else bad "bad token printed: $(cat "$work/hout")"; fi
if ! grep -qF "$tok" "$work/herr" && grep -q "not a token" "$work/herr"; then ok "and stderr names the credential, never its value"; else bad "stderr: $(cat "$work/herr")"; fi
printf '%s\r\n' "$tok" >"$creds/github-read-token"
run_helper github-read-token get "$ask"
if [ ! -s "$work/hout" ] && ! grep -qF "$tok" "$work/herr"; then ok "a token with a carriage return cannot add a line to git's answer"; else bad "CR token: $(cat "$work/hout" "$work/herr")"; fi
: >"$creds/github-read-token"
run_helper github-read-token get "$ask"
if [ ! -s "$work/hout" ] && grep -q "empty or not a token" "$work/herr"; then ok "an empty file prints nothing"; else bad "empty file: $(cat "$work/hout" "$work/herr")"; fi
printf '%s\n' "$tok" >"$creds/github-read-token"
# shellcheck disable=SC2016
if ! grep -qE 'echo|printf' <(grep -nE '>&2' "$helper" | grep -E '\$token|\$\{token'); then ok "no line of the helper sends the token to stderr"; else bad "the helper writes \$token to stderr"; fi
if grep -v '^#' "$helper" | grep -q '/etc/bulig'; then bad "the helper reads from /etc/bulig (root's folder) instead of only the unit's credentials folder"; else ok "the helper reads only \$CREDENTIALS_DIRECTORY, never /etc/bulig"; fi
if grep -nE '(^|[^a-z])(curl|wget|logger|tee|ps)([^a-z]|$)' <(grep -v '^#' "$helper") >/dev/null; then bad "the helper calls a program that could carry the token out"; else ok "the helper calls no program that could carry the token out"; fi

echo "with real git"
# git runs the helper the way the RUNBOOK sets it up: an absolute path with the credential name, from a global config. A fake git-remote
# is not needed: `git credential fill` asks the configured helper exactly as a clone would.
home="$work/home"
mkdir -p "$home"
cfg() { env -i PATH=/usr/bin:/bin:/opt/homebrew/bin HOME="$home" GIT_CONFIG_NOSYSTEM=1 "$@"; }
cfg git config --global credential.https://github.com.helper "$helper github-read-token"
out="$(printf 'protocol=https\nhost=github.com\n\n' | cfg env CREDENTIALS_DIRECTORY="$creds" GIT_TERMINAL_PROMPT=0 git credential fill 2>"$work/gerr")"
if grep -qx "username=x-access-token" <<<"$out" && grep -qx "password=$tok" <<<"$out"; then ok "git credential fill gets the token through the config line the RUNBOOK writes"; else bad "git fill: $out / $(cat "$work/gerr")"; fi
if ! grep -qF "$tok" "$home/.gitconfig"; then ok "the token is not in the git config"; else bad "the token is in $home/.gitconfig"; fi
if [ "$(grep -c . "$home/.gitconfig")" -le 3 ]; then ok "the git config holds only the helper line"; else bad "git config: $(cat "$home/.gitconfig")"; fi
out2="$(printf 'protocol=https\nhost=example.invalid\n\n' | cfg env CREDENTIALS_DIRECTORY="$creds" GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null)" || true
if ! grep -qF "$tok" <<<"$out2"; then ok "git does not ask the helper about another host"; else bad "another host got the token"; fi

echo "the RUNBOOK"
if grep -qF 'credential.https://github.com.helper "/usr/local/lib/bulig/current/git-credential-bulig-read github-read-token"' "$deploy/RUNBOOK.md" && grep -qF 'bulig-cli.sh --as worker --exec git config --global' "$deploy/RUNBOOK.md"; then ok "the RUNBOOK sets the worker's helper as the worker, with --exec git config --global"; else bad "RUNBOOK: no worker helper line"; fi
if grep -qF 'credential.https://github.com.helper "/usr/local/lib/bulig/current/git-credential-bulig-read gh-token"' "$deploy/RUNBOOK.md" && grep -qF 'bulig-cli.sh --as kernel --exec git config --global' "$deploy/RUNBOOK.md"; then ok "the RUNBOOK sets the kernel's helper as the kernel, reading gh-token"; else bad "RUNBOOK: no kernel helper line"; fi
if grep -qF 'security find-generic-password -s bulig-worker-read-token -w | ssh ths-prod-01' "$deploy/RUNBOOK.md" && grep -qF -- '--credential github-read-token' "$deploy/RUNBOOK.md"; then ok "the RUNBOOK stores the token from the Keychain item bulig-worker-read-token over stdin"; else bad "RUNBOOK: no step 4 line for the read token"; fi
if sed -n '/^## Known limits/,/^## Must be proven/p' "$deploy/RUNBOOK.md" | grep -q 'can read the worker.s own read-only token'; then ok "the RUNBOOK's Known limits say the worker's Claude sessions can read the worker's read-only token"; else bad "RUNBOOK: the read-token limit is missing"; fi

finish
