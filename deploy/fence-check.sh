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
# Run it in the server phase (health.sh does). It starts one short transient unit per set.
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
trap 'rm -rf "$work"' EXIT
# What the machine listens on, and which of those sockets systemd holds for another unit. Read once, as text. If either cannot be read, stop:
# without them the check could not tell a socket-activated target from any other, and connecting to one would start that service.
ss -H -ltn >"$work/ss-tcp" 2>/dev/null || die "ss -H -ltn failed, so the listeners cannot be read (the fence check never connects to find out)"
ss -H -xl >"$work/ss-unix" 2>/dev/null || die "ss -H -xl failed, so the unix listeners cannot be read (the fence check never connects to find out)"
systemctl list-sockets --all --no-legend --plain --no-pager >"$work/sockets" 2>/dev/null || die "systemctl list-sockets failed, so socket-activated targets cannot be told apart (the fence check never connects to find out)"
{ ip -o addr 2>/dev/null || true; } >"$work/ip-addr"
python3 -I "$probe" derive "$work/ss-tcp" "$work/ss-unix" "$work/ip-addr" >"$work/derived"
cat "$static_probes" "$work/derived" "$BULIG_FENCE_EXTRA" >"$work/all-probes"

fail=0
for s in "${sets[@]}"; do
  # 1. Which deny targets are really listening? From ss, without connecting. (A target that is not there proves nothing when it cannot be reached.)
  #    Sockets that systemd holds for another unit come back as "activation" and are never connected to.
  control="$(python3 -I "$probe" control "$s" - --ss-tcp "$work/ss-tcp" --ss-unix "$work/ss-unix" --activation "$work/sockets" "${common_args[@]}" <"$work/all-probes" | paste -sd, -)"
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
  rc=0
  out="$(systemd-run --quiet --pipe --wait --collect --unit="bulig-fence-$s-$$" ${ids[@]+"${ids[@]}"} "${props[@]}" \
    -- /usr/bin/python3 -I "$probe" fenced "$s" - "${common_args[@]}" --control "$control" \
    --af "$(prop_value RestrictAddressFamilies)" --ip-deny "$(prop_value IPAddressDeny)" --ip-allow "$(prop_value IPAddressAllow)" \
    --inaccessible "$(prop_value InaccessiblePaths)" ${late_flag[@]+"${late_flag[@]}"} <"$work/all-probes" 2>&1)" || rc=$?
  printf '%s\n' "$out"
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
if [ "$fail" -eq 0 ]; then echo "fence-check: ok"; else echo "fence-check: FAILED"; fi
exit "$fail"
