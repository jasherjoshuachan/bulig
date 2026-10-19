#!/usr/bin/env bash
# Tests for release-remote.sh (the server half of a release) and lib/modules.sh, with a stubbed systemd, a stubbed dependency build and a
# throwaway root. They prove the structure, not just the happy path:
#   - root never writes inside either Bulig user's folder: fake /var/lib/bulig and /var/lib/bulig-worker, laid out as systemd would leave
#     them, are untouched by a release, a rollback and a refusal (nothing new, nothing changed, nothing deleted);
#   - the kernel's config is written to /etc/bulig/config.json (root's), never to a user's folder;
#   - the build sees the source only on stdin (no path of root's trees in its arguments) and runs as a throwaway user in a private /tmp;
#   - what the build hands back is checked: a link that leaves the release, a file outside node_modules, a hard link, a special file, a
#     node_modules where the release has no folder, an empty output are all refused, and the live release stays as it was;
#   - the unpack runs in a sandbox that can write one folder only;
#   - a failed health check, or a failed unit install after the links moved, puts back both links and the unit files;
#   - a sha that is already live is refused.
# shellcheck disable=SC1091,SC2030,SC2031,SC2154
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
export COPYFILE_DISABLE=1

r="$work/r"
stubs="$work/stubs"
mkdir -p "$stubs" "$r/opt/bulig/releases" "$r/usr/local/lib/bulig" "$r/etc/systemd/system" "$r/etc/bulig" "$r/var/lib"
chmod 700 "$r/etc/bulig"
mkdir -m 0700 "$r/var/lib/bulig-checks"
export BULIG_DEPLOY_TEST_ROOT="$r"
export STUB_LOG="$work/log"
mkdir -p "$STUB_LOG"
UNITS="bulig-loopback.service bulig.service bulig-worker.service bulig-backup.service bulig-backup.timer bulig-restore-drill.service bulig-restore-drill.timer"

# The two users' folders, as systemd leaves them. They are given an old date so any later touch shows up.
mkdir -p "$r/var/lib/bulig/state" "$r/var/lib/bulig/repos/sandbox" "$r/var/lib/bulig-worker/work/sandbox" "$r/var/lib/bulig-worker/.claude"
echo "kernel state" >"$r/var/lib/bulig/state/bulig.sqlite"
echo "a clone" >"$r/var/lib/bulig-worker/work/sandbox/README"
echo "claude login" >"$r/var/lib/bulig-worker/.claude/credentials"
find "$r/var/lib/bulig" "$r/var/lib/bulig-worker" -exec touch -t 202001010000 {} +
touch -t 202001010001 "$work/ref-old"
user_listing() { (cd "$r/var/lib" && find bulig bulig-worker | sort && find bulig bulig-worker -type f -exec cksum {} + | sort); }
user_folders_untouched() { # true when nothing under either folder is newer than the old date, and the listing is as it was
  [ -z "$(find "$r/var/lib/bulig" "$r/var/lib/bulig-worker" -newer "$work/ref-old" -print -quit)" ] && [ "$(user_listing)" = "$USER_LISTING" ]
}
USER_LISTING="$(user_listing)"

# --- stubs ---
# systemd-run plays two units. The build (--unit=bulig-build-*) gets the source on stdin, works in its own scratch folder (the unit's
# private /var/tmp), and prints a tar on stdout: STUB_MODULES_TAR if set, else a tar of the folder STUB_MODULES_DIR. The unpack
# (--unit=bulig-extract-*) runs the command after "--" for real, without a sandbox (there is none here).
cat >"$stubs/systemd-run" <<'STUB'
#!/usr/bin/env bash
echo "systemd-run $*" >>"$STUB_LOG/calls"
unit=""
for a in "$@"; do case "$a" in --unit=*) unit="${a#--unit=}" ;; esac; done
case "$unit" in
  bulig-build-*)
    scratch="$(mktemp -d)"
    tar -x -C "$scratch" -f - || exit 1
    [ -f "$scratch/pnpm-lock.yaml" ] || { echo "no lockfile on stdin" >&2; exit 1; }
    if [ -n "${STUB_BUILD_FAIL:-}" ]; then echo "pnpm: install failed" >&2; rm -rf "$scratch"; exit 1; fi
    echo "evil" >>"$scratch/packages/cli/bin/bulig.mjs" # a hostile build edits its own copy; root's trees are not in reach
    if [ -n "${STUB_MODULES_TAR:-}" ]; then cat "$STUB_MODULES_TAR"; else tar -c -C "$STUB_MODULES_DIR" .; fi
    rc=$?
    rm -rf "$scratch"
    exit "$rc" ;;
  bulig-extract-*)
    while [ "$1" != "--" ]; do shift; done
    shift
    exec "$@" ;;
  *) exit 1 ;;
esac
STUB
cat >"$stubs/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "systemctl $*" >>"$STUB_LOG/calls"
exit 0
STUB
# the machine's addresses, as `ip -o addr show scope global` prints them on ths-prod-01
cat >"$stubs/ip" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"scope global"*)
    cat <<'DATA'
2: eth0    inet 203.0.113.10/32 metric 100 scope global dynamic eth0
2: eth0    inet6 2001:db8::10/64 scope global
6: tailscale0    inet 100.64.0.10/32 scope global tailscale0
7: docker0    inet 172.16.0.1/16 brd 172.16.255.255 scope global docker0
DATA
    ;;
esac
STUB

cat >"$stubs/flock" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat >"$stubs/journalctl" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
# mv without -T (this Mac has none), keeping its meaning: replace the destination if it is a link.
cat >"$stubs/mv" <<'STUB'
#!/usr/bin/env bash
args=(); t=0
for a in "$@"; do if [ "$a" = "-T" ]; then t=1; else args+=("$a"); fi; done
if [ "$t" -eq 1 ] && [ -L "${args[1]}" ]; then rm -f "${args[1]}"; fi
exec /bin/mv "${args[@]}"
STUB
cat >"$stubs/head" <<'STUB'
#!/usr/bin/env bash
echo "head $*" >>"$STUB_LOG/head"
exec /usr/bin/head "$@"
STUB
chmod +x "$stubs"/*
export PATH="$stubs:/usr/bin:/bin:/usr/sbin:/sbin"

# What a normal pnpm install leaves: node_modules at the root and in a package, links inside .pnpm, a workspace link, a .bin shim.
mk_modules() { # mk_modules <dir>
  local d="$1"
  rm -rf "$d"
  mkdir -p "$d/node_modules/.pnpm/dep@1.0.0/node_modules/dep" "$d/node_modules/.bin" "$d/packages/cli/node_modules/@bulig"
  echo "module.exports = 1" >"$d/node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js"
  printf '#!/bin/sh\nexit 0\n' >"$d/node_modules/.bin/tool"
  chmod 755 "$d/node_modules/.bin/tool"
  ln -s .pnpm/dep@1.0.0/node_modules/dep "$d/node_modules/dep"
  ln -s ../../../core "$d/packages/cli/node_modules/@bulig/core"
  ln -s ../../../node_modules/dep "$d/packages/cli/node_modules/dep"
}
MODS="$work/mods-src"
mk_modules "$MODS"
export STUB_MODULES_DIR="$MODS"

# deliver <short> <health-exit> [missing-unit]: what release.sh leaves on the server: a root-made folder holding the Node code and deploy/
# (the real release-remote.sh and lib/ are in it, so the real script runs from it).
deliver() {
  local short="$1" hx="$2" missing="${3:-}" inc u
  inc="$(mktemp -d "$r/var/lib/bulig-checks/incoming.XXXXXX")"
  mkdir -p "$inc/packages/cli/bin" "$inc/packages/core" "$inc/deploy/systemd" "$inc/deploy/lib"
  echo "lock" >"$inc/pnpm-lock.yaml"
  echo "{}" >"$inc/package.json"
  echo "console.log('cli $short')" >"$inc/packages/cli/bin/bulig.mjs"
  echo "module.exports = '$short'" >"$inc/packages/core/index.js"
  cp "$deploy/release-remote.sh" "$inc/deploy/"
  cp "$deploy"/lib/*.sh "$inc/deploy/lib/"
  cp "$deploy/bulig.config.vps.json" "$inc/deploy/"
  if [ "$hx" = "flag" ]; then
    # healthy only once the flag file exists (a cause outside the release, such as a missing credential, that is fixed between two runs)
    printf '#!/usr/bin/env bash\n[ -e "%s" ]\n' "$work/health-ok" >"$inc/deploy/health.sh"
  else
    printf '#!/usr/bin/env bash\nexit %s\n' "$hx" >"$inc/deploy/health.sh"
  fi
  chmod 755 "$inc/deploy/health.sh" "$inc/deploy/release-remote.sh"
  for u in $UNITS; do
    [ "$u" = "$missing" ] || printf '[Unit]\n# version %s\n' "$short" >"$inc/deploy/systemd/$u"
  done
  echo "$inc"
}
run_remote() { # run_remote <short> <incoming>: what `ssh host bash <incoming>/deploy/release-remote.sh <short> 5` runs
  bash "$2/deploy/release-remote.sh" "$1" 5
}
link_of() { readlink "$1" 2>/dev/null | xargs -I{} basename {}; }
releases_list() { find "$r/opt/bulig/releases" -mindepth 1 -maxdepth 1 | sort | tr '\n' ' '; }
leftovers() { find "$r/var/lib/bulig-checks" -mindepth 1 -maxdepth 1 | head -3; }

A="aaaaaaaaaaaa"; B="bbbbbbbbbbbb"; C="cccccccccccc"; D="dddddddddddd"

# --- 0. the link rule, on its own ---
echo "safe_link_target"
# shellcheck source=../lib/modules.sh
. "$deploy/lib/modules.sh"
link_case() { # link_case <expect ok|no> <dir of the link> <target>
  local want="$1" dir="$2" target="$3" got=no
  if safe_link_target "$dir" "$target"; then got=ok; fi
  if [ "$got" = "$want" ]; then ok "a link in $dir to '$target' is $want"; else bad "a link in $dir to '$target': wanted $want, got $got"; fi
}
link_case ok "node_modules" ".pnpm/dep@1.0.0/node_modules/dep"
link_case ok "packages/cli/node_modules/@bulig" "../../../core"
link_case ok "packages/cli/node_modules/@bulig" "../../../../cli"
link_case no "packages/cli/node_modules/@bulig" "../../../../.."
link_case no "node_modules" "../.."
link_case ok "node_modules" ".."
link_case no "node_modules/.bin" "/usr/bin/node"
link_case no "node_modules" "/"
link_case no "node_modules" ""
link_case no "node_modules" "a/../../.."
link_case no "node_modules" "dep/../../x"
link_case no "." ".."
link_case ok "." "node_modules/x"
link_case ok "node_modules" "*/weird"
link_case no "node_modules" "../*/../../x"

# --- 0b. check_modules on its own, one rule at a time ---
echo "check_modules"
cm() { ( . "$deploy/lib/common.sh"; . "$deploy/lib/modules.sh"; check_modules "$1" ); }
mk_modules "$work/cm"
expect_ok "a normal pnpm layout passes" cm "$work/cm"
mk_modules "$work/cm"; mkfifo "$work/cm/node_modules/fifo"
expect_fail_msg "a fifo is refused" "not a file, folder or link" cm "$work/cm"
mk_modules "$work/cm"; ln "$work/cm/node_modules/.bin/tool" "$work/cm/node_modules/tool2"
expect_fail_msg "a hard link is refused" "hard link" cm "$work/cm"
mk_modules "$work/cm"; chmod 4755 "$work/cm/node_modules/.bin/tool"
expect_fail_msg "a set-uid file is refused" "set-uid" cm "$work/cm"
mk_modules "$work/cm"; chmod 2755 "$work/cm/node_modules/.bin/tool"
expect_fail_msg "a set-gid file is refused" "set-gid" cm "$work/cm"
mk_modules "$work/cm"; echo x >"$work/cm/packages/cli/stray.js"
expect_fail_msg "a file outside node_modules is refused" "outside node_modules" cm "$work/cm"
mk_modules "$work/cm"; ln -s /etc/passwd "$work/cm/node_modules/abs"
expect_fail_msg "a link to an absolute path is refused" "leaves the release" cm "$work/cm"
mk_modules "$work/cm"; ln -s ../../../../../x "$work/cm/packages/cli/node_modules/@bulig/out"
expect_fail_msg "a link that climbs out is refused" "leaves the release" cm "$work/cm"
mk_modules "$work/cm"; mkdir -p "$work/cm/packages/cli/node_modules/@bulig/sub"; chmod 2755 "$work/cm/packages/cli/node_modules/@bulig/sub"
expect_ok "a set-gid FOLDER is not a reason to refuse (only files)" cm "$work/cm"

# --- 1. a normal release ---
echo "release A"
incA="$(deliver "$A" 0)"
cp "$incA/packages/cli/bin/bulig.mjs" "$work/good-cli.mjs"
cp "$incA/deploy/health.sh" "$work/good-health.sh"
expect_ok "the release runs" run_remote "$A" "$incA"
relA="$r/opt/bulig/releases/$A"
tkA="$r/usr/local/lib/bulig/$A"
if [ "$(link_of "$r/opt/bulig/current")" = "$A" ] && [ "$(link_of "$r/usr/local/lib/bulig/current")" = "$A" ]; then ok "both current links point at the new release"; else bad "links: $(readlink "$r/opt/bulig/current") $(readlink "$r/usr/local/lib/bulig/current")"; fi
if [ -f "$relA/node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js" ] && [ -L "$relA/node_modules/dep" ] && [ -L "$relA/packages/cli/node_modules/@bulig/core" ]; then ok "node_modules from the build are in the release, links included"; else bad "node_modules missing"; fi
if [ -x "$relA/node_modules/.bin/tool" ]; then ok "an executable shim is still executable"; else bad "the shim lost its exec bit"; fi
if cmp -s "$relA/packages/cli/bin/bulig.mjs" "$work/good-cli.mjs"; then ok "a tracked file the build edited in its own copy is as delivered in the release"; else bad "bulig.mjs was changed by the build and kept"; fi
if [ ! -e "$relA/deploy" ]; then ok "the Node tree holds nothing from deploy/"; else bad "deploy/ is inside the Node release tree"; fi
if [ -x "$tkA/health.sh" ] && [ "$(mode "$tkA/health.sh")" = "755" ] && [ "$(mode "$tkA")" = "755" ] && cmp -s "$tkA/health.sh" "$work/good-health.sh"; then ok "the root tools are installed 0755, as delivered"; else bad "tools modes: $(mode "$tkA/health.sh") $(mode "$tkA")"; fi
if [ "$(mode "$relA")" = "755" ] && [ "$(mode "$relA/packages/cli/bin/bulig.mjs")" = "644" ]; then ok "the Node tree is readable by the service users (755 / 644)"; else bad "node tree modes: $(mode "$relA") $(mode "$relA/packages/cli/bin/bulig.mjs")"; fi
if [ -z "$(find "$relA" ! -type l -perm -0002 -print -quit)" ]; then ok "no file or folder in the release is writable by others (links excluded: on Linux a link is always 0777)"; else bad "world-writable file in the release"; fi
if [ -f "$r/etc/systemd/system/bulig.service" ] && grep -q "version $A" "$r/etc/systemd/system/bulig.service"; then ok "the unit files came from the root tools copy"; else bad "unit files not installed"; fi
if [ -f "$r/etc/bulig/config.json" ] && [ "$(mode "$r/etc/bulig/config.json")" = "600" ] && cmp -s "$r/etc/bulig/config.json" "$deploy/bulig.config.vps.json"; then ok "the kernel config is /etc/bulig/config.json, mode 600, from the template"; else bad "config: $(mode "$r/etc/bulig/config.json" 2>&1)"; fi
if [ -z "$(find "$r" -name 'config.json' -not -path "$r/etc/bulig/*")" ] && [ -z "$(find "$r" -name '.bulig' -print -quit)" ]; then ok "no config was written anywhere else (no .bulig folder, no second config.json)"; else bad "a config turned up elsewhere: $(find "$r" -name 'config.json' -o -name '.bulig')"; fi
if user_folders_untouched; then ok "nothing under /var/lib/bulig or /var/lib/bulig-worker was created, changed or deleted"; else bad "a user folder changed: $(find "$r/var/lib/bulig" "$r/var/lib/bulig-worker" -newer "$work/ref-old")"; fi
if [ -z "$(leftovers)" ]; then ok "no incoming or work folders are left behind"; else bad "left: $(leftovers)"; fi
build_call="$(grep -- '--unit=bulig-build-' "$STUB_LOG/calls" | head -1)"
extract_call="$(grep -- '--unit=bulig-extract-' "$STUB_LOG/calls" | head -1)"
for p in DynamicUser=yes PrivateTmp=yes KillMode=control-group ProtectSystem=strict NoNewPrivileges=yes MemoryMax= TasksMax=; do
  case "$build_call" in *"$p"*) ok "the build unit has $p" ;; *) bad "the build unit lacks $p: $build_call" ;; esac
done
DENY="127.0.0.0/8 ::1/128 169.254.0.0/16 fe80::/10 224.0.0.0/4 ff00::/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7"
case "$build_call" in *"-p IPAddressDeny=$DENY 2001:db8::10/128 203.0.113.10/32 -p "*) ok "the build cannot reach localhost, link-local, multicast, private ranges, Tailscale, the docker bridges or this machine's own public addresses (read from ip at run time)" ;; *) bad "the build's IPAddressDeny: $build_call" ;; esac
case "$build_call" in *"IPAddressAllow"*) bad "the build allows an address: $build_call" ;; *) ok "and the build allows no address at all (not even the DNS stub)" ;; esac
case "$build_call" in *"-p RestrictAddressFamilies=AF_INET AF_INET6 -p "*) ok "the build gets IP sockets only: no AF_UNIX, so a tenant's abstract socket is out of reach" ;; *) bad "the build's address families: $build_call" ;; esac
case "$build_call" in *"-p InaccessiblePaths=-/run/tailscale -/run/snapd.socket -/run/docker.sock -/var/run/docker.sock "*) ok "the build cannot see the tailscale, snapd or docker sockets" ;; *) bad "the build's InaccessiblePaths: $build_call" ;; esac
case "$build_call" in *"-p BindReadOnlyPaths=/run/systemd/resolve/resolv.conf:/etc/resolv.conf "*) ok "the build resolves names through resolved's upstream list, not the 127.0.0.53 stub" ;; *) bad "the build's resolver: $build_call" ;; esac
wd="$r/etc/systemd/system/bulig-worker.service.d/10-host-addresses.conf"
if [ -f "$wd" ] && grep -qx "IPAddressDeny=2001:db8::10/128 203.0.113.10/32" "$wd"; then ok "each release refreshes the worker's drop-in with the machine's current public addresses"; else bad "worker drop-in: $(cat "$wd" 2>&1)"; fi
case "$build_call" in *"--uid="* | *" -p User="*) bad "the build is tied to a named user: $build_call" ;; *) ok "the build runs as a throwaway user, not as bulig or bulig-worker" ;; esac
case "$build_call" in *"$r"* | *"/var/lib/bulig-checks"* | *"/usr/local/lib/bulig"*) bad "a path of root's trees reached the build's arguments: $build_call" ;; *) ok "no path of root's trees is in the build's arguments (the source goes in on stdin)" ;; esac
if grep -q "^systemctl enable bulig-loopback.service bulig.service bulig-worker.service" "$STUB_LOG/calls" && grep -q "^systemctl start bulig-loopback.service" "$STUB_LOG/calls"; then ok "the gateway address unit is enabled and started before the services restart"; else bad "systemctl calls: $(grep systemctl "$STUB_LOG/calls" | head -5)"; fi
for p in "ReadWritePaths=$r/var/lib/bulig-checks/rel." ProtectSystem=strict PrivateNetwork=yes CapabilityBoundingSet= NoNewPrivileges=yes ProtectKernelTunables=yes ProtectControlGroups=yes ProtectKernelModules=yes ProtectKernelLogs=yes ProtectClock=yes; do
  case "$extract_call" in *"$p"*) ok "the unpack unit has $p" ;; *) bad "the unpack unit lacks $p: $extract_call" ;; esac
done
rw_values="$(grep -o 'ReadWritePaths=[^ ]*' <<<"$extract_call")"
if [ "$(printf '%s\n' "$rw_values" | wc -l | tr -d ' ')" = "1" ] && case "$rw_values" in *"/mods") true ;; *) false ;; esac; then ok "the unpack unit can write one folder only (the empty mods folder)"; else bad "unpack writable paths: $rw_values"; fi

if grep -qx "head -c $((2 * 1024 * 1024 * 1024 + 1))" "$STUB_LOG/head"; then ok "the build's output is cut at the cap plus one byte on the stream, before it is written (head -c 2 GiB + 1)"; else bad "head calls: $(cat "$STUB_LOG/head" 2>&1)"; fi

# --- 2. an unhealthy release rolls back ---
echo "release B (health check fails)"
incB="$(deliver "$B" 1)"
expect_fail_msg "a failed health check fails the release" "FAILED" run_remote "$B" "$incB"
if [ "$(link_of "$r/opt/bulig/current")" = "$A" ] && [ "$(link_of "$r/usr/local/lib/bulig/current")" = "$A" ]; then ok "both links are back on the previous release"; else bad "links after rollback: $(readlink "$r/opt/bulig/current") $(readlink "$r/usr/local/lib/bulig/current")"; fi
if grep -q "version $A" "$r/etc/systemd/system/bulig.service"; then ok "the unit files are back to the previous release's"; else bad "unit file after rollback: $(cat "$r/etc/systemd/system/bulig.service")"; fi
if user_folders_untouched; then ok "a rollback leaves the user folders alone too"; else bad "a user folder changed during the rollback"; fi
if [ -z "$(leftovers)" ]; then ok "and leaves nothing behind"; else bad "left: $(leftovers)"; fi

# --- 3. a unit that cannot be installed after the links moved rolls back ---
echo "release C (a unit file is missing)"
incC="$(deliver "$C" 0 bulig-worker.service)"
expect_fail_msg "a failed unit install fails the release" "FAILED" run_remote "$C" "$incC"
if [ "$(link_of "$r/opt/bulig/current")" = "$A" ] && [ "$(link_of "$r/usr/local/lib/bulig/current")" = "$A" ]; then ok "and both links are still on the previous release"; else bad "links after the failed install: $(readlink "$r/opt/bulig/current") $(readlink "$r/usr/local/lib/bulig/current")"; fi
if grep -q "version $A" "$r/etc/systemd/system/bulig.service"; then ok "and the unit files are the previous release's"; else bad "unit files after the failed install"; fi

# --- 4. the live sha is refused ---
echo "release A again"
incA2="$(deliver "$A" 0)"
run_remote "$A" "$incA2" >"$work/out" 2>&1
rc=$?
if [ "$rc" -eq 3 ] && grep -q "already the live release" "$work/out"; then ok "a sha that is already live is refused with exit 3"; else bad "rc=$rc: $(cat "$work/out")"; fi
if [ -z "$(leftovers)" ]; then ok "and its incoming folder is removed"; else bad "left: $(leftovers)"; fi
if user_folders_untouched; then ok "and the user folders are untouched"; else bad "a user folder changed"; fi

# --- 4b. a build that fails says so ---
echo "a failed build"
export STUB_BUILD_FAIL=1
incBF="$(deliver "cafecafecafe" 0)"
expect_fail_msg "a build that exits non-zero is reported as failed" "the build failed" run_remote "cafecafecafe" "$incBF"
unset STUB_BUILD_FAIL
if [ "$(readlink "$r/opt/bulig/current")" = "$r/opt/bulig/releases/$A" ] && [ ! -e "$r/usr/local/lib/bulig/cafecafecafe" ]; then ok "and nothing was installed"; else bad "state after a failed build"; fi

# --- 5. a config that is already there is never overwritten ---
echo "release E (existing config)"
echo '{"edited":"by hand"}' >"$r/etc/bulig/config.json"
incE="$(deliver "eeeeeeeeeeee" 0)"
expect_ok "a second release runs" run_remote "eeeeeeeeeeee" "$incE"
if grep -q '"edited"' "$r/etc/bulig/config.json"; then ok "the config edited by hand is kept"; else bad "the config was overwritten"; fi

# --- 6. what the build hands back is checked ---
echo "hostile build output"
live_before="$(readlink "$r/opt/bulig/current")"
releases_before="$(releases_list)"
refused() { # refused <label> <text the message must contain> [sha]: run a release with whatever STUB_* is set; it must be refused and change nothing
  local label="$1" want="$2" sha="${3:-dddddddddddd}" inc
  inc="$(deliver "$sha" 0)"
  expect_fail_msg "$label" "$want" run_remote "$sha" "$inc"
  if [ "$(readlink "$r/opt/bulig/current")" = "$live_before" ] && [ "$(releases_list)" = "$releases_before" ] && [ ! -e "$r/usr/local/lib/bulig/$sha" ]; then ok "  and the live release and the release list are as they were"; else bad "  state changed after '$label'"; fi
  if user_folders_untouched && [ -z "$(leftovers)" ]; then ok "  and the user folders and /var/lib/bulig-checks are clean"; else bad "  dirty after '$label': $(leftovers)"; fi
}
mk_variant() { mk_modules "$work/hostile"; export STUB_MODULES_DIR="$work/hostile"; unset STUB_MODULES_TAR; }

mk_variant; ln -s /etc/passwd "$work/hostile/node_modules/abs"
refused "a link to an absolute path is refused" "leaves the release"
mk_variant; ln -s ../../../../../../etc "$work/hostile/packages/cli/node_modules/up"
refused "a link that climbs out of the release is refused" "leaves the release"
mk_variant; ln -s ../core/../../../x "$work/hostile/packages/cli/node_modules/@bulig/dots"
refused "a link with .. after a name is refused" "leaves the release"
mk_variant; echo "evil" >"$work/hostile/packages/cli/evil.js"
refused "a file outside node_modules is refused" "outside node_modules"
mk_variant; mkdir -p "$work/hostile/packages/cli/bin"; echo "evil" >"$work/hostile/packages/cli/bin/bulig.mjs"
refused "a replacement for a delivered file is refused" "outside node_modules"
mk_variant; ln "$work/hostile/node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js" "$work/hostile/node_modules/hard.js"
refused "a hard link is refused" "hard link"
mk_variant; mkfifo "$work/hostile/node_modules/fifo"
refused "a special file is refused" "not a file, folder or link"
mk_variant; mkdir -p "$work/hostile/nowhere/node_modules/x"; echo 1 >"$work/hostile/nowhere/node_modules/x/i.js"
refused "a node_modules where the release has no folder is refused" "not in the release"
mk_variant; : >"$work/empty.tar"; export STUB_MODULES_TAR="$work/empty.tar"
refused "an empty build output is refused" "produced no node_modules"
unset STUB_MODULES_TAR
mk_variant
export BULIG_DEPLOY_TEST_MAX_MODULES_BYTES=100
refused "a build output over the size limit is refused" "more than the 100 allowed"
unset BULIG_DEPLOY_TEST_MAX_MODULES_BYTES
# set-id bits: whatever the unpack did with them, none may be in the release
mk_variant; echo 'int main(){}' >"$work/hostile/node_modules/suid"; chmod 4755 "$work/hostile/node_modules/suid"
inc="$(deliver "ffffffffffff" 0)"
run_remote "ffffffffffff" "$inc" >"$work/out" 2>&1
if [ -z "$(find "$r/opt/bulig/releases/ffffffffffff" -perm -4000 -print -quit 2>/dev/null)" ]; then ok "no set-uid file is in a release, whatever the unpack did with the bit"; else bad "a set-uid file is in the release"; fi
# a tar that tries to write through a link it made itself (hand-made: a directory cannot hold both)
python3 -I - "$work/through.tar" "$work/decoy" <<'PY'
import sys, tarfile, io
out, decoy = sys.argv[1], sys.argv[2]
with tarfile.open(out, "w") as t:
    d = tarfile.TarInfo("node_modules"); d.type = tarfile.DIRTYPE; d.mode = 0o755; t.addfile(d)
    l = tarfile.TarInfo("node_modules/out"); l.type = tarfile.SYMTYPE; l.linkname = decoy; l.mode = 0o777; t.addfile(l)
    f = tarfile.TarInfo("node_modules/out/planted"); data = b"planted"; f.size = len(data); f.mode = 0o644; t.addfile(f, io.BytesIO(data))
PY
mkdir -p "$work/decoy"
export STUB_MODULES_TAR="$work/through.tar"
live_before="$(readlink "$r/opt/bulig/current")"
releases_before="$(releases_list)"
refused "a tar that writes through its own link is refused" "" "99999999999a"
unset STUB_MODULES_TAR
export STUB_MODULES_DIR="$MODS"

# --- 6b. a failed FIRST release leaves nothing behind ---
echo "a failed first release"
wipe_root() {
  rm -rf "$r/opt/bulig/releases"/* "$r/opt/bulig/current" "$r/opt/bulig/.healthy-sha" "$r/usr/local/lib/bulig"/* "$r/etc/bulig/config.json"
  rm -rf "$r/etc/systemd/system"/bulig*
}
wipe_root
F="f1f1f1f1f1f1"
rm -f "$work/health-ok"
echo "$F" >"$r/opt/bulig/.healthy-sha"   # a stale marker for this very sha: a failed first release must not leave it
incF="$(deliver "$F" flag)"
: >"$STUB_LOG/calls"
expect_fail_msg "a first release that fails its health check fails" "no healthy release to go back to" run_remote "$F" "$incF"
if [ ! -e "$r/opt/bulig/current" ] && [ ! -L "$r/opt/bulig/current" ] && [ ! -e "$r/usr/local/lib/bulig/current" ] && [ ! -L "$r/usr/local/lib/bulig/current" ]; then ok "both current links are removed"; else bad "links left in $r/opt/bulig or $r/usr/local/lib/bulig"; fi
if [ -z "$(find "$r/etc/systemd/system" -name 'bulig*' ! -name '*.d' | head -1)" ]; then ok "the unit files this release installed are removed"; else bad "unit files left: $(find "$r/etc/systemd/system" -name 'bulig*' ! -name '*.d')"; fi
if grep -q "^systemctl disable bulig-worker.service bulig.service bulig-loopback.service" "$STUB_LOG/calls" && grep -q "^systemctl stop bulig-worker.service bulig.service" "$STUB_LOG/calls"; then ok "both services (and the gateway address) are stopped and disabled, so a reboot starts nothing"; else bad "systemctl calls: $(grep systemctl "$STUB_LOG/calls")"; fi
if [ ! -e "$r/opt/bulig/.healthy-sha" ]; then ok "no success marker is written"; else bad "a success marker exists"; fi
if user_folders_untouched; then ok "and the user folders are untouched"; else bad "a user folder changed"; fi
touch "$work/health-ok"
incF2="$(deliver "$F" flag)"
expect_ok "the same sha can be released again" run_remote "$F" "$incF2"
if [ "$(link_of "$r/opt/bulig/current")" = "$F" ] && [ "$(cat "$r/opt/bulig/.healthy-sha")" = "$F" ]; then ok "and it goes live, with the success marker written"; else bad "after the rerun: $(readlink "$r/opt/bulig/current") / $(cat "$r/opt/bulig/.healthy-sha" 2>&1)"; fi
incF3="$(deliver "$F" flag)"
run_remote "$F" "$incF3" >"$work/out" 2>&1
rc=$?
if [ "$rc" -eq 3 ] && grep -q "already the live release" "$work/out"; then ok "and only now is the same sha refused as already live"; else bad "third run rc=$rc: $(cat "$work/out")"; fi
# a release that was linked but never passed its health check is not a place to roll back to
echo "other-sha" >"$r/opt/bulig/.healthy-sha"
G="9a9a9a9a9a9a"
incG="$(deliver "$G" 1)"
: >"$STUB_LOG/calls"
expect_fail_msg "a failing release does not roll back to a current release that never passed health" "no healthy release to go back to" run_remote "$G" "$incG"
if [ ! -e "$r/opt/bulig/current" ] && [ ! -L "$r/opt/bulig/current" ]; then ok "and it is not left linked to the failed one either"; else bad "link left: $(readlink "$r/opt/bulig/current")"; fi
echo "$F" >"$r/opt/bulig/.healthy-sha"
ln -sfn "$r/opt/bulig/releases/$F" "$r/opt/bulig/current"
# a release that was linked but never passed its health check is not 'live' and is not a place to roll back to
echo "stale" >"$r/opt/bulig/.healthy-sha"
incF4="$(deliver "$F" flag)"
expect_ok "a current link whose release never passed health is released again, not refused" run_remote "$F" "$incF4"

# --- 7. bad arguments ---
echo "arguments"
incX="$(deliver "$D" 0)"
expect_fail_msg "a bad sha is refused" "odd short sha" bash "$incX/deploy/release-remote.sh" "xyz" 5
expect_fail_msg "a bad keep count is refused" "odd keep count" bash "$incX/deploy/release-remote.sh" "$D" "five"
mkdir -p "$work/elsewhere/deploy/lib"
cp "$incX/deploy/release-remote.sh" "$work/elsewhere/deploy/"
cp "$incX/deploy/lib/"*.sh "$work/elsewhere/deploy/lib/"
expect_fail_msg "running from outside /var/lib/bulig-checks is refused" "must run from a folder delivered" bash "$work/elsewhere/deploy/release-remote.sh" "$D" 5
if [ -d "$work/elsewhere" ]; then ok "and the refused script's folder is not deleted"; else bad "the folder outside was removed"; fi

finish
