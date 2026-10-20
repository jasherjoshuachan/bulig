#!/usr/bin/env bash
# Does the fence hold on this machine? For each Bulig property set, run a short probe INSIDE a transient unit that has exactly that set's
# network, socket and path properties, and require that it CANNOT reach other tenants' services (localhost, the docker bridge, tailscale, the
# machine's own addresses, unix sockets including an abstract one) and CAN do what the unit needs (DNS, https, its own gateway, a child
# process, a user lookup). Any unexpected success is a failure. The probe list is one file, fence/probes.txt.
#   Probes: fence/probes.txt (published, generic) + ones derived from what this machine listens on + /etc/bulig/fence-extra-probes.txt (root, 0600,
#   required: this script fails without it).
#   usage (root):  fence-check.sh [worker|kernel|build|cli-worker|cli-kernel|all] [--no-late | --late-only] [--late-strict]
#   worker, kernel  properties are read from what systemd has LOADED (systemctl show: drop-ins, set-property and all); BULIG_FENCE_SOURCE=files
#                   reads the unit file and its drop-ins instead (the offline path the tests use). SupplementaryGroups= is refused.
#   build           the transient release-build unit's properties (build_fence_props in lib/common.sh)
#   cli-worker, cli-kernel   bulig-cli.sh's properties (cli_fence_props in lib/common.sh)
#   --late-only     only the probes that need the kernel to be up (the gateway); --late-strict makes a miss a failure, not a warning
# Run it in the server phase (health.sh does). It starts one short transient unit per set, ALL AT THE SAME TIME, and waits for every one of them.
#   Speed (none of this changes a verdict): a blocked connection is a DROPPED packet, so it ends in a timeout, and run one after another that
#   was 5 sets x about 180 probes x 3 s (about 40 minutes on the server). Now: blocked (deny) probes wait only BULIG_FENCE_DENY_TIMEOUT seconds
#   (default 1.5; allow probes keep their 3 s and a timeout is still a FAIL for them), run BULIG_FENCE_JOBS at a time inside their unit (default
#   32), and the sets run side by side. A set that has not finished after BULIG_FENCE_SET_TIMEOUT seconds in total (default 240) is stopped and
#   reported as "FAIL <set> timeout ..." (so health fails; a set that hangs never passes). Results print in a fixed order: the sets as asked,
#   each set's probes in the probe file's order.
#
# THE RULE: this script never completes a connection to anything that is not Bulig's, from any context, and never wakes a socket-activated unit.
#   - "Is it listening?" comes from ss (tcp listeners, unix and abstract listeners), never from connecting.
#   - A target that systemd holds as a socket for another unit (systemctl list-sockets) is never connected to by anything. It is judged from the
#     unit's properties only, and reported as "activation socket: checked by properties only".
#   - Known limits are reported from the unit's properties and ss, labelled "known limit, not tested by connecting".
#   - What does connect: the allow probes (Bulig's own gateway and Postgres socket, DNS, github, anthropic) and the deny probes inside the fence,
#     which must fail before they reach anything. A deny probe that succeeds IS a real connection to another service; that is why it is a failure.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
# shellcheck source=lib/fence.sh
. "$here/lib/fence.sh"
need_root

sets=()
late_flag=()
strict=0
for a in "$@"; do
  case "$a" in
    --no-late) late_flag=(--no-late) ;;
    --late-only) late_flag=(--late-only) ;;
    --late-strict) strict=1 ;;
    worker | kernel | build | cli-worker | cli-kernel) sets+=("$a") ;;
    all) sets=(worker kernel build cli-worker cli-kernel) ;;
    *) die "usage: fence-check.sh [worker|kernel|build|cli-worker|cli-kernel|all] [--no-late | --late-only] [--late-strict]" ;;
  esac
done
[ "${#sets[@]}" -gt 0 ] || sets=(worker kernel build cli-worker cli-kernel)
command -v python3 >/dev/null 2>&1 || die "python3 not found"
command -v systemd-run >/dev/null 2>&1 || die "systemd-run not found"

static_probes="${BULIG_FENCE_PROBES:-$here/fence/probes.txt}"
probe="$here/fence-probe.py"
[ -r "$static_probes" ] && [ -r "$probe" ] || die "the probe files are missing next to this script"
# The machine-specific probes are required: without them the tenants on this machine would silently not be probed.
[ -s "$BULIG_FENCE_EXTRA" ] || die "$BULIG_FENCE_EXTRA is missing or empty. Fill in fence/extra-probes.template and install it with set-secret.sh --fence-extra-probes (RUNBOOK, 'The extra probes')."
(fence_extra_check "$BULIG_FENCE_EXTRA") || die "$BULIG_FENCE_EXTRA is not usable (see above)"
host_addrs="$(host_addresses | tr '\n' ' ')"
common_args=(--host-addrs "$host_addrs")

# One probe stream for all sets: the published probes, the ones derived from what this machine is listening on right now, and the extra file.
# It is handed to the probe on stdin, so the unit never needs to read a file of root's.
work="$(private_tmpdir)"
pids=()
names=()
# shellcheck disable=SC2329
cleanup() { # whatever is still running (an early exit, ^C, a die) is stopped, so no probe unit is left behind; then the work folder goes
  local i
  for i in ${pids[@]+"${!pids[@]}"}; do
    if kill -0 "${pids[$i]}" 2>/dev/null; then
      systemctl stop "${names[$i]}.service" >/dev/null 2>&1 || true
      kill "${pids[$i]}" 2>/dev/null || true
    fi
  done
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
deny_timeout="${BULIG_FENCE_DENY_TIMEOUT:-1.5}"
par="${BULIG_FENCE_JOBS:-32}"
set_cap="${BULIG_FENCE_SET_TIMEOUT:-240}"
[[ "$deny_timeout" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "BULIG_FENCE_DENY_TIMEOUT must be a number of seconds, not '$deny_timeout'"
[[ "$par" =~ ^[0-9]+$ ]] && [ "$par" -ge 1 ] && [ "$par" -le 256 ] || die "BULIG_FENCE_JOBS must be a whole number from 1 to 256, not '$par'"
[[ "$set_cap" =~ ^[0-9]+$ ]] && [ "$set_cap" -ge 5 ] && [ "$set_cap" -le 3600 ] || die "BULIG_FENCE_SET_TIMEOUT must be a whole number of seconds from 5 to 3600, not '$set_cap'"
# What the machine listens on, and which of those sockets systemd holds for another unit. Read once, as text. If either cannot be read, stop:
# without them the check could not tell a socket-activated target from any other, and connecting to one would start that service.
ss -H -ltn >"$work/ss-tcp" 2>/dev/null || die "ss -H -ltn failed, so the listeners cannot be read (the fence check never connects to find out)"
ss -H -xl >"$work/ss-unix" 2>/dev/null || die "ss -H -xl failed, so the unix listeners cannot be read (the fence check never connects to find out)"
systemctl list-sockets --all --no-legend --plain --no-pager >"$work/sockets" 2>/dev/null || die "systemctl list-sockets failed, so socket-activated targets cannot be told apart (the fence check never connects to find out)"
{ ip -o addr 2>/dev/null || true; } >"$work/ip-addr"
python3 -I "$probe" derive "$work/ss-tcp" "$work/ss-unix" "$work/ip-addr" >"$work/derived"
cat "$static_probes" "$work/derived" "$BULIG_FENCE_EXTRA" >"$work/all-probes"

fail=0
# Start every set. (Everything that can refuse a set - a missing unit, no IP filter - happens in this loop, before a probe unit exists for a later
# set to leave behind; the cleanup above stops the ones already started if it does.)
for s in "${sets[@]}"; do
  # 1. Which deny targets are really listening? From ss, without connecting. (A target that is not there proves nothing when it cannot be reached.)
  #    (Whether a target is socket-activated is decided inside the fenced run, from the target and the systemctl list-sockets text it is given.)
  control="$(python3 -I "$probe" control "$s" - --ss-tcp "$work/ss-tcp" --ss-unix "$work/ss-unix" "${common_args[@]}" <"$work/all-probes" | paste -sd, -)"
  # 2. The set's properties.
  ids=()
  case "$s" in
    worker | kernel)
      unit="bulig-worker.service"
      if [ "$s" = "kernel" ]; then unit="bulig.service"; fi
      [ -f "$BULIG_UNIT_DIR/$unit" ] || die "$unit is not installed in $BULIG_UNIT_DIR, so its fence cannot be tested"
      # On the server the properties come from what systemd has loaded. BULIG_FENCE_SOURCE=files|show forces one (the tests do).
      if [ "$(fence_source)" = "show" ]; then unit_loaded_props "$unit"; else unit_fence_props "$unit"; fi
      props=("${UNIT_PROPS[@]}")
      ids=(--uid="${UNIT_USER:-bulig}")
      if [ "$s" = "worker" ]; then ids=(--uid="${UNIT_USER:-bulig-worker}"); fi
      # A unit with no IP filter or no address-family list has no fence: that is a failure of its own, not something to probe around.
      case " ${props[*]} " in *" IPAddressDeny="*) ;; *) die "$unit has no IPAddressDeny=" ;; esac
      case " ${props[*]} " in *" RestrictAddressFamilies="*) ;; *) die "$unit has no RestrictAddressFamilies=" ;; esac
      ;;
    # The real build sets HOME explicitly (release-remote.sh); a DynamicUser has no passwd entry to take it from.
    build) build_fence_props; props=("${FENCE_BUILD[@]}" --setenv=HOME=/var/tmp/home) ;;
    cli-worker) cli_fence_props worker; props=("${FENCE_CLI[@]}"); ids=(--uid=bulig-worker) ;;
    cli-kernel) cli_fence_props kernel; props=("${FENCE_CLI[@]}"); ids=(--uid=bulig) ;;
  esac
  [ "${#props[@]}" -gt 0 ] || die "no fence properties found for $s (is the unit installed?)"
  # The unit's properties, handed to the probe as plain values: known limits and activation sockets are judged from them.
  prop_value() { # prop_value <Key>: the value of -p Key=... in props (the last one), or nothing
    local v="" e
    for e in "${props[@]}"; do case "$e" in "$1="*) v="${e#*=}" ;; esac; done
    printf '%s' "$v"
  }
  # 3. Inside: the probe, with exactly those properties. (The unit's other properties do not change what it can reach.)
  #    It runs in the background, writing to its own file; the next loop reads them in order.
  unit_name="bulig-fence-$s-$$"
  systemd-run --quiet --pipe --wait --collect --unit="$unit_name" ${ids[@]+"${ids[@]}"} "${props[@]}" -p "RuntimeMaxSec=$((set_cap + 15))" \
    -- /usr/bin/python3 -I "$probe" fenced "$s" - "${common_args[@]}" --control "$control" \
    --activation-text "$(cat "$work/sockets")" --af "$(prop_value RestrictAddressFamilies)" --ip-deny "$(prop_value IPAddressDeny)" --ip-allow "$(prop_value IPAddressAllow)" \
    --inaccessible "$(prop_value InaccessiblePaths)" --deny-timeout "$deny_timeout" --jobs "$par" ${late_flag[@]+"${late_flag[@]}"} <"$work/all-probes" >"$work/out-$s" 2>&1 &
  pids+=("$!")
  names+=("$unit_name")
done
# Collect them in the order they were asked for. The whole run has one clock: every set started together, so every set is due at the same moment.
deadline=$((SECONDS + set_cap))
for i in "${!sets[@]}"; do
  s="${sets[$i]}"
  while kill -0 "${pids[$i]}" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.2; done
  rc=0
  timed_out=0
  if kill -0 "${pids[$i]}" 2>/dev/null; then
    # Not finished in time. Stop the unit (that kills the probe inside it), then the waiting systemd-run.
    timed_out=1
    systemctl stop "${names[$i]}.service" >/dev/null 2>&1 || true
    kill "${pids[$i]}" 2>/dev/null || true
    wait "${pids[$i]}" 2>/dev/null || true
  else
    wait "${pids[$i]}" || rc=$?
  fi
  out="$(cat "$work/out-$s")"
  if [ -n "$out" ]; then printf '%s\n' "$out"; fi
  if [ "$timed_out" -eq 1 ]; then
    echo "FAIL $s timeout the set did not finish within ${set_cap}s ($(grep -cE '^(ok|FAIL|warn|info) ' <<<"$out" || true) result lines came before it was stopped); a set that does not finish is never a pass"
    fail=1
    continue
  fi
  # (here-strings, not printf | grep -q: under pipefail grep -q can close the pipe early and make printf fail)
  if grep -q '^FAIL ' <<<"$out"; then fail=1; fi
  # The probe exits 1 only after printing its FAIL lines. Any other non-zero exit means it did not run (a property systemd refused, a crash).
  if [ "$rc" -ne 0 ] && ! grep -q '^FAIL ' <<<"$out"; then echo "FAIL $s did-not-run systemd-run or the probe exited $rc without a result"; fail=1; fi
  if [ "$strict" -eq 1 ] && grep -q '^warn .* not reachable yet' <<<"$out"; then
    echo "FAIL $s gateway-not-reachable the kernel is up but the worker's set cannot reach its gateway"
    fail=1
  fi
  # A set that printed nothing at all did not run.
  if [ -z "$out" ]; then echo "FAIL $s no-output the probe printed nothing"; fail=1; fi
done
echo "info fence-check ${#sets[@]} set(s) in ${SECONDS}s (blocked probes wait ${deny_timeout}s, ${par} at a time)"
if [ "$fail" -eq 0 ]; then echo "fence-check: ok"; else echo "fence-check: FAILED"; fi
exit "$fail"
