#!/usr/bin/env bash
# The server half of a release. release.sh (run on the Mac) streams `git archive <sha>` over ssh into a fresh root-owned folder,
# /var/lib/bulig-checks/incoming.XXXXXX, and runs THIS file from inside it, as root. So the copy that runs is always the one in the commit,
# never a file on the server that either Bulig user could have touched.
#   usage: bash <incoming>/deploy/release-remote.sh <short-sha> <keep>        (arguments checked below)
#
# THE INVARIANT: root never creates, writes, chmods, chowns or deletes a path whose parent a Bulig user owns or can write. Every path
# this script writes is under /var/lib/bulig-checks, /opt/bulig, /usr/local/lib/bulig, /etc/bulig, /etc/systemd/system or (one file,
# bulig-bwrap) /etc/apparmor.d, all root's.
# It never goes near /var/lib/bulig or /var/lib/bulig-worker: systemd makes those (StateDirectory=), and the programs fill them.
#
# What it does with the delivered tree:
#   - deploy/ becomes /usr/local/lib/bulig/<sha>: the scripts ROOT runs, and the unit files. Never built in, never given to a Bulig user.
#   - the rest is the Node code. Its dependencies are installed by a throwaway user (DynamicUser) in a transient unit whose private /var/tmp
#     systemd deletes when the unit ends. The source goes in on stdin and only a tar of the node_modules folders comes out on stdout. Root
#     never enters a folder that user wrote to. The tar is unpacked by root inside a second sandbox that can write one folder only,
#     checked (types, hard links, set-id bits, links that leave the release), and only then are the node_modules folders moved next to a
#     fresh copy of the delivered code. A build script cannot change a delivered file or keep a handle into the live release.
#   - both `current` links and the unit files are swapped, bwrap's AppArmor profile (/etc/apparmor.d/bulig-bwrap) installed and loaded if it
#     differs, the services restarted, health checked; any failure puts all of it back.
#   - just before the first of those changes, a "before" snapshot of the host (release-<sha>.before.snapshot); after the health check (or
#     the rollback) postcheck.sh compares the host with it and reports the result. It never fails or rolls back the release.
#
# BULIG_DEPLOY_TEST_ROOT puts every path under a throwaway folder and skips the owner checks. On the server it is never set.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
# shellcheck source=lib/modules.sh
. "$here/lib/modules.sh"
need_root

[ "$#" -eq 2 ] || die "usage: release-remote.sh <short-sha> <keep>"
short="$1"
keep="$2"
[[ "$short" =~ ^[0-9a-f]{12}$ ]] || die "odd short sha"
[[ "$keep" =~ ^[0-9]+$ ]] || die "odd keep count"

inc="$(cd "$here/.." && pwd -P)"
[ "$(dirname "$inc")" = "$(cd "$BULIG_CHECKS_DIR" 2>/dev/null && pwd -P || echo none)" ] || die "this script must run from a folder delivered into $BULIG_CHECKS_DIR"
[[ "$(basename "$inc")" =~ ^incoming\.[A-Za-z0-9]{6}$ ]] || die "odd incoming folder name"

OPT="$BULIG_OPT_DIR"
TK="$BULIG_TOOLS_DIR"
SD="$BULIG_UNIT_DIR"
CHK="$BULIG_CHECKS_DIR"
rel="$OPT/releases/$short"
tk_rel="$TK/$short"
cur="$OPT/current"
tk_cur="$TK/current"
units="bulig-loopback.service bulig.service bulig-worker.service bulig-backup.service bulig-backup.timer bulig-restore-drill.service bulig-restore-drill.timer"
# The build gets at most this many bytes of node_modules to hand back.
MAX_MODULES_BYTES=$((2 * 1024 * 1024 * 1024))
# (the tests lower it; on the server R is empty and this line does nothing)
if [ -n "$R" ] && [ -n "${BULIG_DEPLOY_TEST_MAX_MODULES_BYTES:-}" ]; then MAX_MODULES_BYTES="$BULIG_DEPLOY_TEST_MAX_MODULES_BYTES"; fi

for d in "$OPT/releases" "$TK" "$BULIG_CRED_DIR" "$SD" "$CHK"; do need_dir "$d"; done
need_dir "$OPT"

swap_link() { ln -sfn "$1" "$2.new" && mv -T "$2.new" "$2"; }

work=""
unit_backup=""
# shellcheck disable=SC2329
cleanup() {
  if [ -n "$work" ]; then rm -rf "$work"; fi
  rm -rf "$inc"
}
trap cleanup EXIT

# One release at a time on this host.
exec 9>"$OPT/.release.lock"
flock -n 9 || die "another release is running on this host"
find "$CHK" -maxdepth 1 \( -name 'incoming.*' -o -name 'rel.*' \) -mmin +1440 ! -path "$inc" -exec rm -rf {} + 2>/dev/null || true

prev=""
prev_tk=""
if [ -L "$cur" ]; then prev="$(readlink "$cur")"; fi
if [ -L "$tk_cur" ]; then prev_tk="$(readlink "$tk_cur")"; fi
# A release counts as live only once it passed its health check: $OPT/.healthy-sha holds the sha of the last one that did. A first release that
# failed leaves nothing behind (links, units and services are put back), and a rerun of the same sha is not refused.
healthy_file="$OPT/.healthy-sha"
healthy=""
if [ -f "$healthy_file" ]; then healthy="$(cat "$healthy_file")"; fi
if [ "$prev" = "$rel" ] && [ "$healthy" = "$short" ]; then
  echo "release: $short is already the live release. Nothing changed." >&2
  exit 3
fi
# What to go back to if this one fails: the current release, if it is the one that last passed its health check.
prev_healthy=""
if [ -n "$prev" ] && [ "$(basename "$prev")" = "$healthy" ]; then prev_healthy="$prev"; fi

work="$(mktemp -d "$CHK/rel.XXXXXX")"
pristine="$work/pristine"
tools="$work/tools"
mods="$work/mods"
final="$work/final"

# --- the build -------------------------------------------------------------------------------------------------------------------
# build_modules <source dir> <out tar>: tar of the source in on stdin, tar of every node_modules folder out on stdout.
# FENCE_BUILD (lib/common.sh): the build runs dependency scripts, so it reaches the public internet (the npm registry) and nothing else: no
# unix socket at all (no AF_UNIX: a tenant's abstract socket would be reachable otherwise), not 127.0.0.1 (other tenants' services), not the
# docker bridges, private ranges, Tailscale or this host's own public addresses; DNS through resolved's upstream list.
# DynamicUser: a throwaway uid with no files, no home and no credentials. PrivateTmp: /tmp and /var/tmp are private and systemd removes
# them when the unit ends, so nothing it wrote survives and root never has to enter them. KillMode=control-group: every process a
# build script started dies with the unit. pnpm's own output goes to stderr so stdout is only the tar.
build_modules() {
  local src="$1" out="$2"
  # shellcheck disable=SC2016
  local script='set -eu
mkdir -m 0700 /var/tmp/home /var/tmp/build
cd /var/tmp/build
tar -x --no-same-owner -f -
pnpm install --frozen-lockfile --prod=false --config.package-import-method=copy --store-dir /var/tmp/pnpm-store </dev/null >&2
find . -name node_modules -type d -prune -print0 | tar -c --hard-dereference --null -T - -f -'
  build_fence_props
  local rc=0 got
  # head -c: at most one byte more than the cap is ever written to disk, whatever the build sends.
  tar -c -C "$src" . | systemd-run --quiet --pipe --wait --collect --unit="bulig-build-$short-$$" "${FENCE_BUILD[@]}" \
    -p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=yes -p PrivateDevices=yes -p NoNewPrivileges=yes \
    -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes \
    -p UMask=0022 \
    -p KillMode=control-group -p SendSIGKILL=yes -p MemoryMax=2G -p CPUQuota=200% -p TasksMax=512 -p RuntimeMaxSec=1800 \
    --setenv=HOME=/var/tmp/home --setenv=PATH=/usr/local/bin:/usr/bin:/bin --setenv=CI=true \
    -- /bin/sh -c "$script" | head -c "$((MAX_MODULES_BYTES + 1))" >"$out" || rc=$?
  got="$(wc -c <"$out" | tr -d ' ')"
  [ "$got" -le "$MAX_MODULES_BYTES" ] || die "the build output is more than the $MAX_MODULES_BYTES allowed"
  [ "$rc" -eq 0 ] || die "the build failed (exit $rc)"
}

# extract_modules <tar> <empty dest>: root unpacks the tar, but in a sandbox where the destination is the one writable place and there is
# no network and no capability. A link inside the archive cannot be used to write anywhere else.
extract_modules() {
  local tarfile="$1" dest="$2"
  systemd-run --quiet --pipe --wait --collect --unit="bulig-extract-$short-$$" \
    -p ProtectSystem=strict -p "ReadWritePaths=$dest" -p ProtectHome=yes -p PrivateTmp=yes -p PrivateDevices=yes -p PrivateNetwork=yes \
    -p NoNewPrivileges=yes -p CapabilityBoundingSet= -p RestrictAddressFamilies=AF_UNIX -p MemoryMax=1G -p TasksMax=16 -p UMask=0022 \
    -p ProtectKernelTunables=yes -p ProtectControlGroups=yes -p ProtectKernelModules=yes -p ProtectKernelLogs=yes -p ProtectClock=yes \
    -p KillMode=control-group \
    -- /usr/bin/tar -x --no-same-owner --no-same-permissions -f - -C "$dest" <"$tarfile"
}

# --- 1. the root tools: copied and checked now, moved into place only once the Node tree is built, so a refused release leaves nothing ---
cp -a "$inc/deploy" "$tools"
if is_root && [ -n "$(find "$tools" ! -user root -print -quit)" ]; then die "the delivered tools are not all owned by root"; fi
chmod -R u=rwX,go=rX "$tools"

# --- 2. the Node tree --------------------------------------------------------------------------------------------------------------
if [ -d "$rel" ]; then
  echo "release: $short is already unpacked (not live); reusing it"
else
  cp -a "$inc" "$pristine"
  rm -rf "$pristine/deploy"
  [ -f "$pristine/pnpm-lock.yaml" ] || die "the delivered tree has no pnpm-lock.yaml"
  mkdir -m 0700 "$mods"
  build_modules "$pristine" "$work/modules.tar"
  size="$(wc -c <"$work/modules.tar" | tr -d ' ')"
  [ "$size" -gt 0 ] || die "the build produced no node_modules"
  extract_modules "$work/modules.tar" "$mods"
  check_modules "$mods"
  # The final tree: a fresh copy of what was delivered, plus the node_modules folders, moved in. Nothing else from the build.
  cp -a "$pristine" "$final"
  while IFS= read -r -d '' nm; do
    relp="${nm#"$mods"/}"
    parent="$(dirname "$relp")"
    [ -d "$final/$parent" ] && [ ! -L "$final/$parent" ] || die "the build made a node_modules in a folder that is not in the release: $relp"
    { [ ! -e "$final/$relp" ] && [ ! -L "$final/$relp" ]; } || die "the release already holds $relp"
    mv "$nm" "$final/$relp"
  done < <(find "$mods" -name node_modules -type d -prune -print0)
  chmod -R u=rwX,go=rX "$final"
  mv -T "$final" "$rel"
fi

if [ -d "$tk_rel" ]; then
  echo "release: tools for $short are already installed; reusing them"
else
  mv -T "$tools" "$tk_rel"
fi

# --- 2b. the "before" picture, just before this release changes anything the snapshot covers (lib/snapshot.sh) -----------------------
# Everything above wrote only under Bulig's own folders and ran Bulig's own transient units, which the snapshot leaves out; from step 3 on,
# unit files, the AppArmor profile and services change. So the comparison against THIS snapshot after the health check (release_compare)
# covers this release, not every other tenant's work since the precheck (precheck.snapshot stays: it is the baseline for removing Bulig).
# /var/lib/bulig-checks/release-<sha>.before.snapshot, root, 0600; the newest $SNAPSHOT_RELEASE_KEEP are kept, older ones removed.
# It runs in a child shell so that set -e holds inside snapshot(), as in precheck.sh: a command that fails there leaves no snapshot rather
# than a partial one. A missing snapshot does not refuse the release (health decides it); the comparison is skipped and says so.
snap="$CHK/release-$short.before.snapshot"
# shellcheck disable=SC2016
if bash -c 'set -euo pipefail; . "$1/lib/common.sh"; . "$1/lib/snapshot.sh"; trap '\''[ -z "${SNAPSHOT_TMP:-}" ] || rm -f "$SNAPSHOT_TMP"'\'' EXIT; snapshot_save "$2"; snapshot_prune_releases' _ "$here" "$snap"; then
  echo "release: saved the before snapshot $snap ($(wc -l <"$snap" | tr -d ' ') lines)"
else
  echo "release: WARNING: could not take the before snapshot (see above), so this release will not be compared with it" >&2
  rm -f "$snap"
  snap=""
fi
# release_compare <when>: postcheck.sh against that snapshot. It reports and never decides: health decides the release. Another tenant can
# change things while a release runs, so a difference is not proof that this release made it (see the RUNBOOK, step 5).
release_compare() {
  if [ -z "$snap" ]; then
    echo "release: postcheck skipped $1: there is no before snapshot for this release" >&2
    return 0
  fi
  echo "release: postcheck $1, against $snap"
  if bash "$here/postcheck.sh" --against "$snap"; then
    echo "release: postcheck ok: nothing the snapshot covers changed during this release, apart from Bulig's own things"
  else
    echo "release: WARNING: POSTCHECK FAILED $1: something the snapshot covers changed during this release and it is not Bulig's (the diff is above), or the postcheck could not run. Nothing is rolled back for it. Find out whose change it is: another tenant's, or this release's." >&2
  fi
}

# --- 3. keep what is installed now (unit files), so a rollback restores all of it ---------------------------------------------------
unit_backup="$work/unit-backup"
mkdir -m 0700 "$unit_backup"
for u in $units; do
  if [ -e "$SD/$u" ]; then cp -p "$SD/$u" "$unit_backup/$u"; fi
done
restore_units() {
  for u in $units; do
    if [ -e "$unit_backup/$u" ]; then cp -p "$unit_backup/$u" "$SD/$u"; else rm -f "$SD/$u"; fi
  done
}

# --- 3b. the AppArmor profile for bubblewrap (Jasher, 21 Oct 2026) ---------------------------------------------------------------------
# Claude Code runs every Bash command in bubblewrap, which makes a user namespace. Ubuntu 24.04 (kernel.apparmor_restrict_unprivileged_userns=1)
# allows that only to a program whose AppArmor profile says `userns`, so deploy/apparmor/bulig-bwrap gives /usr/bin/bwrap exactly that and
# nothing else (the profile is unconfined otherwise). It is /etc/apparmor.d/bulig-bwrap (root, 0644), written only when it differs from the
# release's copy, then loaded with apparmor_parser -r; a file that is already right but not loaded is loaded. No other file in /etc/apparmor.d is
# touched. Where AppArmor is not enabled, nothing is written and a note says so. A failure fails the release, which puts the previous file
# (or no file) back, like the units.
aa_src="$tk_rel/apparmor/$BULIG_APPARMOR_PROFILE"
aa_dst="$BULIG_APPARMOR_DIR/$BULIG_APPARMOR_PROFILE"
aa_backup="$work/apparmor-backup"
aa_changed=0
aa_loaded() { [ -r "$BULIG_APPARMOR_LOADED" ] && grep -q "^$BULIG_APPARMOR_PROFILE " "$BULIG_APPARMOR_LOADED"; }
install_apparmor() {
  if [ "$(cat "$BULIG_APPARMOR_ENABLED" 2>/dev/null)" != "Y" ]; then
    echo "apparmor: not enabled on this machine, so $aa_dst is not installed (Claude Code's Bash sandbox needs bwrap to make user namespaces; see the RUNBOOK)"
    return 0
  fi
  command -v apparmor_parser >/dev/null 2>&1 || { echo "apparmor: enabled, but apparmor_parser is not installed, so bwrap's profile cannot be loaded" >&2; return 1; }
  [ -f "$aa_src" ] || { echo "apparmor: the release has no apparmor/$BULIG_APPARMOR_PROFILE" >&2; return 1; }
  # (need_dir and install_root_file die on a refusal; in a subshell that is a failed step, so the rollback below still runs)
  (need_dir "$BULIG_APPARMOR_DIR") || return 1
  [ ! -L "$aa_dst" ] || { echo "apparmor: $aa_dst is a link. Not touching it." >&2; return 1; }
  if [ -f "$aa_dst" ] && cmp -s "$aa_src" "$aa_dst"; then
    if aa_loaded; then echo "apparmor: $aa_dst is as in the release and loaded"; return 0; fi
    apparmor_parser -r "$aa_dst" || { echo "apparmor: apparmor_parser -r $aa_dst failed" >&2; return 1; }
    echo "apparmor: $aa_dst was as in the release but not loaded; loaded it"
    return 0
  fi
  if [ -f "$aa_dst" ]; then cp -p "$aa_dst" "$aa_backup"; fi
  aa_changed=1
  (install_root_file "$aa_dst") <"$aa_src" || return 1
  apparmor_parser -r "$aa_dst" || { echo "apparmor: apparmor_parser -r $aa_dst failed" >&2; return 1; }
  echo "apparmor: installed and loaded $aa_dst (root, 0644)"
}
# restore_apparmor: only if this release changed the file. The previous one goes back and is reloaded, or, when there was none, the profile is
# unloaded and the file removed. A file that was already right but not loaded, and was only loaded here, stays loaded on a rollback: the file
# on disk is unchanged, and a reboot would load it anyway.
restore_apparmor() {
  [ "$aa_changed" -eq 1 ] || return 0
  if [ -f "$aa_backup" ]; then
    { (install_root_file "$aa_dst") <"$aa_backup" && apparmor_parser -r "$aa_dst"; } || echo "apparmor: could not put the previous $aa_dst back" >&2
  else
    if [ -f "$aa_dst" ]; then apparmor_parser -R "$aa_dst" || true; fi
    rm -f "$aa_dst"
  fi
}

# --- 4. swap both links, install the units of the new release, restart, check --------------------------------------------------------
# Every step ends in "|| return 1": inside an `if` the shell ignores set -e, so a failed step would otherwise be skipped over and the
# release would look fine.
apply_release() {
  swap_link "$rel" "$cur" || return 1
  swap_link "$tk_rel" "$tk_cur" || return 1
  echo "current -> $rel, tools -> $tk_rel (previous: ${prev:-none})"
  for u in $units; do install -m 0644 "$tk_rel/systemd/$u" "$SD/$u" || return 1; done
  # The kernel's config is a root-owned credential, /etc/bulig/config.json. Made once, from the template; never overwritten.
  if [ ! -e "$BULIG_CRED_DIR/config.json" ] && [ ! -L "$BULIG_CRED_DIR/config.json" ]; then
    install -m 0600 "$tk_rel/bulig.config.vps.json" "$BULIG_CRED_DIR/config.json" || return 1
    echo "config: created $BULIG_CRED_DIR/config.json from the VPS template (Telegram off, no local worker). Edit it as root; it is never overwritten."
  fi
  write_host_dropin bulig-worker.service || return 1
  install_apparmor || return 1
  systemctl daemon-reload || return 1
  systemctl enable bulig-loopback.service bulig.service bulig-worker.service >/dev/null 2>&1 || return 1
  systemctl start bulig-loopback.service || return 1
  systemctl restart bulig.service bulig-worker.service || return 1
  "$tk_cur/health.sh" --wait 40 || return 1
}

prune() { # prune <dir> <live path> <previous path>: keep the newest $keep release folders, never the live or the previous one
  local dir="$1" live="$2" before="$3" n=0 d
  while IFS= read -r d; do
    [ -d "$dir/$d" ] && [ ! -L "$dir/$d" ] || continue
    case "$d" in .* | incoming.* | rel.*) continue ;; esac
    [[ "$d" =~ ^[0-9a-f]{12}$ ]] || continue
    n=$((n + 1))
    [ "$n" -gt "$keep" ] || continue
    [ "$dir/$d" = "$live" ] || [ "$dir/$d" = "$before" ] || rm -rf "${dir:?}/$d"
  done < <(ls -1t "$dir")
}

if apply_release; then
  printf '%s\n' "$short" >"$healthy_file.new" && mv -T "$healthy_file.new" "$healthy_file"
  echo "release: healthy on $short"
  release_compare "after the health check"
  prune "$OPT/releases" "$rel" "$prev"
  prune "$TK" "$tk_rel" "$prev_tk"
  exit 0
fi

echo "release: install, restart or health check FAILED on $short" >&2
journalctl -u bulig.service -u bulig-worker.service -n 40 --no-pager >&2 || true
if [ -n "$prev_healthy" ] && [ -d "$prev_healthy" ]; then
  echo "release: rolling back to $prev_healthy (Node tree, root tools and unit files)" >&2
  swap_link "$prev" "$cur"
  if [ -n "$prev_tk" ] && [ -d "$prev_tk" ]; then swap_link "$prev_tk" "$tk_cur"; fi
  restore_units
  restore_apparmor
  systemctl daemon-reload
  systemctl restart bulig.service bulig-worker.service
  if [ -x "$tk_cur/health.sh" ] && "$tk_cur/health.sh" --wait 40; then
    echo "release: rolled back, healthy on $(basename "$prev")" >&2
  else
    echo "release: rollback is ALSO unhealthy. Look at journalctl -u bulig.service -u bulig-worker.service." >&2
  fi
  release_compare "after the rollback"
else
  # A failed FIRST release leaves nothing behind: services stopped and disabled (a reboot starts nothing), both current links and the unit files
  # removed, and no success marker, so the same sha can be released again.
  echo "release: no healthy release to go back to. Stopping and disabling both services and removing what this release installed." >&2
  systemctl stop bulig-worker.service bulig.service || true
  systemctl disable bulig-worker.service bulig.service bulig-loopback.service >/dev/null 2>&1 || true
  systemctl stop bulig-loopback.service || true
  rm -f "$cur" "$tk_cur" "$healthy_file"
  restore_units
  restore_apparmor
  systemctl daemon-reload || true
  release_compare "after removing the failed first release"
fi
exit 1
