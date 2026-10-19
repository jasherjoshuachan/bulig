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

# unit_fence_props <unit>: sets UNIT_PROPS (the -p arguments for systemd-run) and UNIT_USER by reading the unit file and its drop-ins. This is the
# offline path (tests, and any machine without systemd); on the server fence-check.sh uses unit_loaded_props.
UNIT_PROPS=()
UNIT_USER=""
unit_fence_props() {
  local unit="$1" key v
  UNIT_PROPS=()
  UNIT_USER="$(unit_last "$unit" User)"
  [ -z "$(unit_list "$unit" SupplementaryGroups)" ] || die "$unit has SupplementaryGroups=$(unit_list "$unit" SupplementaryGroups): a Bulig user must not gain another group's files or sockets"
  for key in IPAddressDeny IPAddressAllow RestrictAddressFamilies InaccessiblePaths BindPaths BindReadOnlyPaths; do
    v="$(unit_list "$unit" "$key")"
    if [ -n "$v" ]; then UNIT_PROPS+=(-p "$key=$v"); fi
  done
  for key in ProtectSystem PrivateTmp ProtectHome ProtectProc; do
    v="$(unit_last "$unit" "$key")"
    if [ -n "$v" ]; then UNIT_PROPS+=(-p "$key=$v"); fi
  done
}

# unit_loaded_props <unit>: the same arrays, but from what systemd has LOADED (systemctl show), the one true source: it includes drop-ins, set-property
# changes and a unit file edited without a daemon-reload not yet applied. Dies if the unit is not loaded or has supplementary groups.
unit_loaded_props() {
  local unit="$1" out key v
  out="$(systemctl show -p LoadState,User,IPAddressDeny,IPAddressAllow,RestrictAddressFamilies,InaccessiblePaths,BindPaths,BindReadOnlyPaths,SupplementaryGroups,ProtectSystem,PrivateTmp,ProtectHome,ProtectProc "$unit")" || die "systemctl show $unit failed"
  shown() { printf '%s\n' "$out" | awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print; exit }'; }
  [ "$(shown LoadState)" = "loaded" ] || die "$unit is not loaded by systemd, so its fence cannot be tested"
  [ -z "$(shown SupplementaryGroups)" ] || die "$unit has SupplementaryGroups=$(shown SupplementaryGroups): a Bulig user must not gain another group's files or sockets"
  UNIT_PROPS=()
  UNIT_USER="$(shown User)"
  for key in IPAddressDeny IPAddressAllow RestrictAddressFamilies InaccessiblePaths BindPaths BindReadOnlyPaths; do
    v="$(shown "$key")"
    if [ -n "$v" ]; then UNIT_PROPS+=(-p "$key=$v"); fi
  done
  for key in ProtectSystem PrivateTmp ProtectHome ProtectProc; do
    v="$(shown "$key")"
    if [ -n "$v" ]; then UNIT_PROPS+=(-p "$key=$v"); fi
  done
}

# fence_source: where the worker and kernel properties come from. "show" (systemctl show: what systemd has loaded) on the server; "files" when the
# paths are redirected for the tests (BULIG_DEPLOY_TEST_ROOT set). BULIG_FENCE_SOURCE=files|show forces one.
fence_source() {
  if [ -n "${BULIG_FENCE_SOURCE:-}" ]; then printf '%s' "$BULIG_FENCE_SOURCE"; elif [ -z "$R" ]; then printf show; else printf files; fi
}
