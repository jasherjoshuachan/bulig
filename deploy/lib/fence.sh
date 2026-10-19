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

# unit_fence_props <unit>: sets UNIT_PROPS (the -p arguments for systemd-run) and UNIT_USER from the unit as it is installed, drop-ins included.
UNIT_PROPS=()
UNIT_USER=""
unit_fence_props() {
  local unit="$1" key v
  UNIT_PROPS=()
  UNIT_USER="$(unit_last "$unit" User)"
  for key in IPAddressDeny IPAddressAllow RestrictAddressFamilies InaccessiblePaths BindReadOnlyPaths; do
    v="$(unit_list "$unit" "$key")"
    if [ -n "$v" ]; then UNIT_PROPS+=(-p "$key=$v"); fi
  done
  for key in ProtectSystem PrivateTmp ProtectHome ProtectProc; do
    v="$(unit_last "$unit" "$key")"
    if [ -n "$v" ]; then UNIT_PROPS+=(-p "$key=$v"); fi
  done
}
