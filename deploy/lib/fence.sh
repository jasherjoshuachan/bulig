# shellcheck shell=bash disable=SC2034
# Reading a unit file (and its drop-ins) the way systemd merges them, for fence-check.sh. Source it after common.sh; do not run it.

# unit_list <unit> <Key>: the values of a list-type key (IPAddressDeny, InaccessiblePaths, ...) from the unit file and then its drop-ins in
# name order, joined by spaces. An empty assignment (Key=) empties the list, as in systemd.
unit_list() {
  local unit="$1" key="$2" f line v out=""
  for f in "$BULIG_UNIT_DIR/$unit" "$BULIG_UNIT_DIR/$unit.d"/*.conf; do
    [ -f "$f" ] || continue
    while IFS= read -r line; do
      case "$line" in
        "$key="*)
          v="${line#*=}"
          if [ -z "$v" ]; then out=""; else out="$out${out:+ }$v"; fi
          ;;
      esac
    done <"$f"
  done
  printf '%s' "$out"
}

# unit_last <unit> <Key>: the last value of a single-value key, or nothing.
unit_last() {
  local unit="$1" key="$2" f line out=""
  for f in "$BULIG_UNIT_DIR/$unit" "$BULIG_UNIT_DIR/$unit.d"/*.conf; do
    [ -f "$f" ] || continue
    while IFS= read -r line; do
      case "$line" in "$key="*) out="${line#*=}" ;; esac
    done <"$f"
  done
  printf '%s' "$out"
}

# Besides the network and path properties, the ones that decide whether Claude Code's sandbox (bwrap) can start: they change what /proc looks like,
# which system calls work and which capabilities a process can hold, so the bwrap probe has to run with the unit's real values (21 Oct 2026).
# And NetworkNamespacePath (22 Oct 2026): the worker's probe must run in the worker's own network namespace, or it would test the host's.
FENCE_LIST_EXTRA="ReadOnlyPaths SystemCallFilter SystemCallArchitectures"
FENCE_SINGLE_EXTRA="ProtectKernelTunables ProtectKernelLogs ProtectHostname ProcSubset ProtectKernelModules ProtectControlGroups ProtectClock PrivateDevices NoNewPrivileges RestrictSUIDSGID RestrictRealtime LockPersonality MemoryDenyWriteExecute NetworkNamespacePath"
# Passed on even when empty: CapabilityBoundingSet= (empty) is the unit's real value, and leaving it out would give the probe every capability.
FENCE_KEEP_EMPTY="CapabilityBoundingSet"
# unit_has <unit> <Key>: is the key set at all in the unit file or a drop-in (an empty assignment counts)?
unit_has() {
  local unit="$1" key="$2" f
  for f in "$BULIG_UNIT_DIR/$unit" "$BULIG_UNIT_DIR/$unit.d"/*.conf; do
    [ -f "$f" ] || continue
    if grep -q "^$key=" "$f"; then return 0; fi
  done
  return 1
}

# unit_fence_props <unit>: sets UNIT_PROPS (the -p arguments for systemd-run) and UNIT_USER by reading the unit file and its drop-ins. This is the
# offline path (tests, and any machine without systemd); on the server fence-check.sh uses unit_loaded_props.
UNIT_PROPS=()
UNIT_USER=""
unit_fence_props() {
  local unit="$1" key v
  UNIT_PROPS=()
  UNIT_USER="$(unit_last "$unit" User)"
  [ -z "$(unit_list "$unit" SupplementaryGroups)" ] || die "$unit has SupplementaryGroups=$(unit_list "$unit" SupplementaryGroups): a Bulig user must not gain another group's files or sockets"
  for key in IPAddressDeny IPAddressAllow RestrictAddressFamilies InaccessiblePaths BindPaths BindReadOnlyPaths $FENCE_LIST_EXTRA; do
    v="$(unit_list "$unit" "$key")"
    if [ -n "$v" ]; then UNIT_PROPS+=(-p "$key=$v"); fi
  done
  for key in ProtectSystem PrivateTmp ProtectHome ProtectProc $FENCE_SINGLE_EXTRA; do
    v="$(unit_last "$unit" "$key")"
    if [ -n "$v" ]; then UNIT_PROPS+=(-p "$key=$v"); fi
  done
  for key in $FENCE_KEEP_EMPTY; do
    if unit_has "$unit" "$key"; then UNIT_PROPS+=(-p "$key=$(unit_list "$unit" "$key")"); fi
  done
}

# unit_loaded_props <unit>: the same arrays, but from what systemd has LOADED (systemctl show), the one true source: it includes drop-ins, set-property
# changes and a unit file edited without a daemon-reload not yet applied. Dies if the unit is not loaded or has supplementary groups.
unit_loaded_props() {
  local unit="$1" out key v
  out="$(systemctl show -p "LoadState,User,IPAddressDeny,IPAddressAllow,RestrictAddressFamilies,InaccessiblePaths,BindPaths,BindReadOnlyPaths,SupplementaryGroups,ProtectSystem,PrivateTmp,ProtectHome,ProtectProc,${FENCE_LIST_EXTRA// /,},${FENCE_SINGLE_EXTRA// /,},${FENCE_KEEP_EMPTY// /,}" "$unit")" || die "systemctl show $unit failed"
  shown() { printf '%s\n' "$out" | awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print; exit }'; }
  [ "$(shown LoadState)" = "loaded" ] || die "$unit is not loaded by systemd, so its fence cannot be tested"
  [ -z "$(shown SupplementaryGroups)" ] || die "$unit has SupplementaryGroups=$(shown SupplementaryGroups): a Bulig user must not gain another group's files or sockets"
  UNIT_PROPS=()
  UNIT_USER="$(shown User)"
  for key in IPAddressDeny IPAddressAllow RestrictAddressFamilies InaccessiblePaths BindPaths BindReadOnlyPaths $FENCE_LIST_EXTRA; do
    v="$(shown "$key")"
    if [ -n "$v" ]; then UNIT_PROPS+=(-p "$key=$v"); fi
  done
  for key in ProtectSystem PrivateTmp ProtectHome ProtectProc $FENCE_SINGLE_EXTRA; do
    v="$(shown "$key")"
    if [ -n "$v" ]; then UNIT_PROPS+=(-p "$key=$v"); fi
  done
  for key in $FENCE_KEEP_EMPTY; do
    if printf '%s\n' "$out" | grep -q "^$key="; then UNIT_PROPS+=(-p "$key=$(shown "$key")"); fi
  done
}

# fence_source: where the worker and kernel properties come from. "show" (systemctl show: what systemd has loaded) on the server; "files" when the
# paths are redirected for the tests (BULIG_DEPLOY_TEST_ROOT set). BULIG_FENCE_SOURCE=files|show forces one.
fence_source() {
  if [ -n "${BULIG_FENCE_SOURCE:-}" ]; then printf '%s' "$BULIG_FENCE_SOURCE"; elif [ -z "$R" ]; then printf show; else printf files; fi
}

# netns_inode <path>: the inode of the network namespace at that path (/proc/self/ns/net, /run/netns/<name>), which names it. Under the tests
# (BULIG_DEPLOY_TEST_ROOT set, no /proc) the numbers come from BULIG_TEST_NETNS_HOST and BULIG_TEST_NETNS_WORKER instead.
netns_inode() {
  if [ -n "$R" ]; then
    case "$1" in
      /proc/self/ns/net) printf '%s' "${BULIG_TEST_NETNS_HOST:-4026531840}" ;;
      *) [ -e "$R$1" ] || return 1; printf '%s' "${BULIG_TEST_NETNS_WORKER:-4026532300}" ;;
    esac
    return 0
  fi
  stat -L -c %i "$1" 2>/dev/null
}

# netns_args <set> <NetworkNamespacePath value>: sets NETNS_ARGS, the --netns guard for the probe. The worker sets must run in the worker's own
# network namespace: a set with no NetworkNamespacePath, or another one, or one that does not exist or is the host's own, is refused here.
NETNS_ARGS=()
netns_args() {
  local set="$1" path="$2" host want
  NETNS_ARGS=()
  case "$set" in worker | cli-worker) ;; *) return 0 ;; esac
  [ "$path" = "$BULIG_NETNS_PATH" ] || die "the $set set has NetworkNamespacePath='$path', not $BULIG_NETNS_PATH: the worker must run in its own network namespace"
  host="$(netns_inode /proc/self/ns/net)" || die "cannot read this host's network namespace (/proc/self/ns/net)"
  want="$(netns_inode "$BULIG_NETNS_PATH")" || die "$BULIG_NETNS_PATH does not exist: start bulig-netns.service and bulig-pasta.service (the worker's network namespace) first"
  [ -n "$host" ] && [ -n "$want" ] || die "could not read the inodes of the host's and the worker's network namespaces"
  [ "$host" != "$want" ] || die "$BULIG_NETNS_PATH is the host's own network namespace"
  NETNS_ARGS=(--netns "$host:$want")
  # (the tests only: a probe outside Linux has no /proc/self/ns/net, so the run says which namespace it would be in)
  if [ -n "$R" ] && [ -n "${BULIG_TEST_NETNS_SELF:-$want}" ]; then NETNS_ARGS+=(--self-netns "${BULIG_TEST_NETNS_SELF:-$want}"); fi
}
