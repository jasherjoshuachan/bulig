#!/usr/bin/env bash
# Does the fence hold on this machine? For each Bulig property set, run a short probe INSIDE a transient unit that has exactly that set's
# network, socket and path properties, and require that it CANNOT reach other tenants' services (localhost, the docker bridge, tailscale, the
# machine's own addresses, unix sockets including an abstract one) and CAN do what the unit needs (DNS, https, its own gateway, a child
# process, a user lookup). Any unexpected success is a failure. The probe list is one file, fence/probes.txt.
#   usage (root):  fence-check.sh [worker|kernel|build|cli-worker|cli-kernel|all] [--no-late | --late-only] [--late-strict]
#   worker, kernel  properties are read from what systemd has LOADED (systemctl show: drop-ins, set-property and all); BULIG_FENCE_SOURCE=files
#                   reads the unit file and its drop-ins instead (the offline path the tests use). SupplementaryGroups= is refused.
#   build           the transient release-build unit's properties (build_fence_props in lib/common.sh)
#   cli-worker, cli-kernel   bulig-cli.sh's properties (cli_fence_props in lib/common.sh)
#   --late-only     only the probes that need the kernel to be up (the gateway); --late-strict makes a miss a failure, not a warning
# Run it in the server phase (health.sh does). It starts one short transient unit per set.
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

probes="${BULIG_FENCE_PROBES:-$here/fence/probes.txt}"
probe="$here/fence-probe.py"
[ -r "$probes" ] && [ -r "$probe" ] || die "the probe files are missing next to this script"
host_addrs="$(host_addresses | tr '\n' ' ')"
tailscale="$(ip -4 -o addr show dev tailscale0 2>/dev/null | awk '{ sub("/.*", "", $4); print $4; exit }' || true)"
common_args=(--host-addrs "$host_addrs")
if [ -n "$tailscale" ]; then common_args+=(--tailscale "$tailscale"); fi

fail=0
for s in "${sets[@]}"; do
  # 1. Outside every fence: which deny targets are really listening? (A target that is not there proves nothing when it cannot be reached.)
  control="$(python3 -I "$probe" control "$s" "$probes" "${common_args[@]}" | paste -sd, -)"
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
  # 3. Inside: the probe, with exactly those properties. (The unit's other properties do not change what it can reach.)
  rc=0
  out="$(systemd-run --quiet --pipe --wait --collect --unit="bulig-fence-$s-$$" ${ids[@]+"${ids[@]}"} "${props[@]}" \
    -- /usr/bin/python3 -I "$probe" fenced "$s" "$probes" "${common_args[@]}" --control "$control" ${late_flag[@]+"${late_flag[@]}"} 2>&1)" || rc=$?
  printf '%s\n' "$out"
  if printf '%s\n' "$out" | grep -q '^FAIL '; then fail=1; fi
  # The probe exits 1 only after printing its FAIL lines. Any other non-zero exit means it did not run (a property systemd refused, a crash).
  if [ "$rc" -ne 0 ] && ! printf '%s\n' "$out" | grep -q '^FAIL '; then echo "FAIL $s did-not-run systemd-run or the probe exited $rc without a result"; fail=1; fi
  if [ "$strict" -eq 1 ] && printf '%s\n' "$out" | grep -q '^warn .* not reachable yet'; then
    echo "FAIL $s gateway-not-reachable the kernel is up but the worker's set cannot reach its gateway"
    fail=1
  fi
  # A set that printed nothing at all did not run.
  if [ -z "$out" ]; then echo "FAIL $s no-output the probe printed nothing"; fail=1; fi
done
if [ "$fail" -eq 0 ]; then echo "fence-check: ok"; else echo "fence-check: FAILED"; fi
exit "$fail"
