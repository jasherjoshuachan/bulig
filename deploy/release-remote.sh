#!/usr/bin/env bash
# The server half of a release. release.sh (run on the Mac) sends this file to the server over ssh as root and runs it there, so the copy
# that runs is always the one in the checkout, never a file on the server that bulig could have touched.
#   usage: bash -s -- <short-sha> <keep> <incoming-name>        (arguments checked below)
#
# Two trees come from the Mac, both root-owned from the moment they arrive:
#   /opt/bulig/releases/<incoming>    the Node code (git archive minus deploy/). Run as bulig and bulig-worker.
#   /usr/local/lib/bulig/<incoming>   deploy/: the scripts ROOT runs (health, backup, drill, checks) and the unit files.
# The rule: nothing root executes may ever live in a tree that bulig owned, even for a moment. So
#   - the root tools are installed straight from the delivered copy, which bulig never sees;
#   - the dependency install runs on a COPY of the Node tree, as a transient unit (so every process it starts dies with the unit);
#   - the final Node tree is a fresh copy of the delivered one with only the node_modules folders moved in. Every other file is a new file,
#     so an old open handle left by a build script points at a dead copy and cannot reach the live release.
#
# BULIG_DEPLOY_TEST_ROOT puts every path under a throwaway folder and skips the owner changes. On the server it is never set.
set -euo pipefail

R="${BULIG_DEPLOY_TEST_ROOT:-}"
die() { echo "release: $*" >&2; exit 1; }
[ "$#" -eq 3 ] || die "usage: release-remote.sh <short-sha> <keep> <incoming-name>"
short="$1"; keep="$2"; name="$3"
[[ "$short" =~ ^[0-9a-f]{12}$ ]] || die "odd short sha"
[[ "$keep" =~ ^[0-9]+$ ]] || die "odd keep count"
[[ "$name" =~ ^\.incoming-[0-9a-f]{12}-[0-9]+$ ]] || die "odd incoming name"
if [ -z "$R" ] && [ "$(id -u)" -ne 0 ]; then die "run as root"; fi

OPT="$R/opt/bulig"
TK="$R/usr/local/lib/bulig"
SD="$R/etc/systemd/system"
VAR="$R/var/lib/bulig"
node_in="$OPT/releases/$name"
tk_in="$TK/$name"
rel="$OPT/releases/$short"
tk_rel="$TK/$short"
cur="$OPT/current"
tk_cur="$TK/current"
pristine="$node_in.pristine"
build="$node_in.build"
final="$node_in.final"
units="bulig.service bulig-worker.service bulig-backup.service bulig-backup.timer bulig-restore-drill.service bulig-restore-drill.timer"

own() { if [ -z "$R" ]; then chown "$@"; fi; }
swap_link() { ln -sfn "$1" "$2.new" && mv -T "$2.new" "$2"; }

unit_backup=""
# shellcheck disable=SC2329
cleanup() { rm -rf "$node_in" "$tk_in" "$pristine" "$build" "$final"; if [ -n "$unit_backup" ]; then rm -rf "$unit_backup"; fi; }
trap cleanup EXIT

[ -d "$OPT/releases" ] && [ -d "$TK" ] || die "$OPT/releases or $TK is missing. Run setup-user.sh first."
[ -d "$node_in" ] && [ -d "$tk_in" ] || die "the delivered trees are missing"

# One release at a time on this host.
exec 9>"$OPT/.release.lock"
flock -n 9 || die "another release is running on this host"
find "$OPT/releases" "$TK" -maxdepth 1 -name '.incoming-*' -mmin +1440 -exec rm -rf {} + 2>/dev/null || true

prev=""; prev_tk=""
if [ -L "$cur" ]; then prev="$(readlink "$cur")"; fi
if [ -L "$tk_cur" ]; then prev_tk="$(readlink "$tk_cur")"; fi
if [ "$prev" = "$rel" ]; then
  echo "release: $short is already the live release. Nothing changed." >&2
  exit 3
fi

# 1. The root tools. Delivered by root, never owned by bulig: installed as they arrived, read-only for everyone but root.
if [ -d "$tk_rel" ]; then
  echo "release: tools for $short are already installed; reusing them"
else
  own -R root:root "$tk_in"
  chmod -R u=rwX,go=rX "$tk_in"
  mv -T "$tk_in" "$tk_rel"
fi

# 2. The Node tree.
if [ -d "$rel" ]; then
  echo "release: $short is already unpacked (not live); reusing it"
else
  own -R root:root "$node_in"
  mv "$node_in" "$pristine"
  # bulig gets a copy to install into. The delivered tree (pristine) is never given to bulig.
  cp -a "$pristine" "$build"
  own -R bulig:bulig "$build"
  # A transient unit, not a bare process: when the install ends, systemd kills everything left in its cgroup, so a build script cannot leave a
  # background process behind. Dependency build scripts still run (better-sqlite3 needs its build), as bulig, with caps and a read-only system.
  systemd-run --quiet --pipe --wait --collect --uid=bulig --gid=bulig --working-directory="$build" \
    -p KillMode=control-group -p SendSIGKILL=yes -p MemoryMax=2G -p CPUQuota=200% -p TasksMax=512 \
    -p NoNewPrivileges=yes -p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=read-only \
    -p "ReadWritePaths=$build /var/lib/bulig" \
    --setenv=HOME=/var/lib/bulig --setenv=PATH="/usr/local/bin:/usr/bin:/bin:/var/lib/bulig/.local/bin" \
    -- /usr/bin/env pnpm install --frozen-lockfile --prod=false --config.package-import-method=copy --store-dir /var/lib/bulig/.local/share/pnpm/store
  # The final tree: a fresh copy of what was delivered, plus the node_modules folders from the install, moved in. Nothing else from the build.
  cp -a "$pristine" "$final"
  while IFS= read -r -d '' nm; do
    relp="${nm#"$build"/}"
    [ -d "$final/$(dirname "$relp")" ] || die "the install created a node_modules in a folder that is not in the release: $relp"
    [ ! -e "$final/$relp" ] || die "the release already holds $relp"
    mv "$nm" "$final/$relp"
  done < <(find "$build" -name node_modules -type d -prune -print0)
  own -R root:root "$final"
  chmod -R go-w "$final"
  # An extra check on top of the construction: outside node_modules the final tree is exactly what was delivered.
  if ! diff -rq --exclude=node_modules "$pristine" "$final" >/dev/null; then
    diff -rq --exclude=node_modules "$pristine" "$final" >&2 || true
    die "the final tree differs from the delivered one outside node_modules. Refusing this release."
  fi
  mv -T "$final" "$rel"
fi
rm -rf "$pristine" "$build"

# 3. Keep what is installed now (both symlinks and the unit files), so a rollback restores all of it.
unit_backup="$(mktemp -d "$OPT/.unit-backup.XXXXXX")"
for u in $units; do
  if [ -e "$SD/$u" ]; then cp -p "$SD/$u" "$unit_backup/$u"; fi
done
restore_units() {
  for u in $units; do
    if [ -e "$unit_backup/$u" ]; then cp -p "$unit_backup/$u" "$SD/$u"; else rm -f "$SD/$u"; fi
  done
}

# 4. Swap both symlinks, install the units of the new release, restart, check. Every step ends in "|| return 1": inside an `if` the shell
#    ignores set -e, so a failed step would otherwise be skipped over and the release would look fine.
apply_release() {
  swap_link "$rel" "$cur" || return 1
  swap_link "$tk_rel" "$tk_cur" || return 1
  echo "current -> $rel, tools -> $tk_rel (previous: ${prev:-none})"
  for u in $units; do install -m 0644 "$tk_rel/systemd/$u" "$SD/" || return 1; done
  if [ ! -e "$VAR/.bulig/config.json" ]; then
    install -m 0640 "$tk_rel/bulig.config.vps.json" "$VAR/.bulig/config.json" || return 1
    own root:bulig "$VAR/.bulig/config.json" || return 1
    echo "config: created $VAR/.bulig/config.json from the VPS template (Telegram off, local worker off)"
  fi
  systemctl daemon-reload || return 1
  systemctl enable bulig.service bulig-worker.service >/dev/null 2>&1 || return 1
  systemctl restart bulig.service bulig-worker.service || return 1
  "$tk_cur/health.sh" --wait 40 || return 1
}

prune() { # prune <dir> <live path> <previous path>: keep the newest $keep release folders, never the live or the previous one
  local dir="$1" live="$2" before="$3" n=0 d
  while IFS= read -r d; do
    [ -d "$dir/$d" ] && [ ! -L "$dir/$d" ] || continue
    case "$d" in .*) continue ;; esac
    n=$((n + 1))
    [ "$n" -gt "$keep" ] || continue
    [ "$dir/$d" = "$live" ] || [ "$dir/$d" = "$before" ] || rm -rf "${dir:?}/$d"
  done < <(ls -1t "$dir")
}

if apply_release; then
  echo "release: healthy on $short"
  prune "$OPT/releases" "$rel" "$prev"
  prune "$TK" "$tk_rel" "$prev_tk"
  exit 0
fi

echo "release: install, restart or health check FAILED on $short" >&2
journalctl -u bulig.service -u bulig-worker.service -n 40 --no-pager >&2 || true
if [ -n "$prev" ] && [ -d "$prev" ]; then
  echo "release: rolling back to $prev (Node tree, root tools and unit files)" >&2
  swap_link "$prev" "$cur"
  if [ -n "$prev_tk" ] && [ -d "$prev_tk" ]; then swap_link "$prev_tk" "$tk_cur"; fi
  restore_units
  systemctl daemon-reload
  systemctl restart bulig.service bulig-worker.service
  if [ -x "$tk_cur/health.sh" ] && "$tk_cur/health.sh" --wait 40; then
    echo "release: rolled back, healthy on $(basename "$prev")" >&2
  else
    echo "release: rollback is ALSO unhealthy. Look at journalctl -u bulig.service -u bulig-worker.service." >&2
  fi
else
  echo "release: no previous release to go back to. Stopping both services so they do not crash-loop." >&2
  systemctl stop bulig-worker.service bulig.service || true
fi
exit 1
