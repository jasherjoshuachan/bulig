#!/usr/bin/env bash
# The invariant: root never creates, writes, chmods, chowns or deletes a path whose parent a Bulig user owns or can write.
# invariant.py reads every script root runs and every unit file. This suite runs it on the real kit (it must find nothing), then on the
# same kit with ONE bad edit made in memory (invariant_cases.py), to prove the checker sees each way of breaking the rule, and does
# not cry wolf at things that are fine. A few cases also go through the real command line, with real files.
# shellcheck disable=SC1091,SC2030,SC2031,SC2154
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

checker="$deploy/test/invariant.py"
check() { python3 -I "$checker" "$1"; }

echo "the real kit"
expect_ok "no root script or root unit writes inside a Bulig user's folder" check "$deploy"
n_scripts="$(find "$deploy" -name '*.sh' -not -path "$deploy/test/*" | wc -l | tr -d ' ')"
n_units="$(find "$deploy/systemd" -type f | wc -l | tr -d ' ')"
summary="$(check "$deploy" | tail -1)"
case "$summary" in *"checked $n_scripts scripts and $n_units units"*) ok "it read all $n_scripts scripts and $n_units unit files" ;; *) bad "coverage: $summary (expected $n_scripts scripts, $n_units units)" ;; esac

echo "cases (each is one edit that must be caught, or must not)"
python3 -I "$deploy/test/invariant_cases.py" "$deploy" >"$work/cases" 2>&1
total=0
while IFS= read -r line; do
  total=$((total + 1))
  case "$line" in
    "ok "*) ok "${line#ok }" ;;
    *) bad "${line#FAIL }" ;;
  esac
done <"$work/cases"
if [ "$total" -ge 80 ]; then ok "the case driver ran $total cases"; else bad "the case driver ran only $total cases: $(head -c 300 "$work/cases")"; fi

echo "through the command line"
cp -R "$deploy/." "$work/k"
rm -rf "$work/k/test"
expect_ok "an unchanged copy passes" check "$work/k"
printf '\ninstall -d -m 0700 /var/lib/bulig/state\n' >>"$work/k/setup-user.sh"
expect_fail_msg "a copy with one bad line fails, and names the line" "setup-user.sh:" check "$work/k"
rm -rf "$work/k"
cp -R "$deploy/." "$work/k"
rm -rf "$work/k/test"
sed -i.bak 's/^StateDirectory=bulig$//' "$work/k/systemd/bulig.service"
expect_fail_msg "a copy whose kernel unit lost its StateDirectory fails" "[state-directory]" check "$work/k"
expect_fail "no argument is an error, not a pass" python3 -I "$checker"

finish
