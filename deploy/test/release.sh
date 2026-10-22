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
UNITS="bulig-loopback.service bulig-netns.service bulig-pasta.service bulig.service bulig-worker.service bulig-backup.service bulig-backup.timer bulig-restore-drill.service bulig-restore-drill.timer"

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
# What the snapshot reads (lib/snapshot.sh): the units, unit files and timers of a small fake host, from STUB_SNAP.
case "$1" in
  list-units) if printf '%s ' "$@" | grep -q -- '--state=running'; then awk '$4 == "running"' "$STUB_SNAP/units.txt"; else cat "$STUB_SNAP/units.txt"; fi ;;
  list-unit-files) cat "$STUB_SNAP/unitfiles.txt" ;;
  list-timers) cat "$STUB_SNAP/timers.txt" ;;
esac
exit 0
STUB
# The rest of what the snapshot reads, from the same fake host. STUB_SS_FAIL makes ss fail, as on a host where it cannot run.
cat >"$stubs/ss" <<'STUB'
#!/usr/bin/env bash
if [ -n "${STUB_SS_FAIL:-}" ]; then echo "ss: cannot open netlink socket" >&2; exit 1; fi
cat "$STUB_SNAP/ss.txt"
STUB
cat >"$stubs/getent" <<'STUB'
#!/usr/bin/env bash
cat "$STUB_SNAP/$1.txt"
STUB
cat >"$stubs/docker" <<'STUB'
#!/usr/bin/env bash
cat "$STUB_SNAP/docker.txt"
STUB
cat >"$stubs/pg_lsclusters" <<'STUB'
#!/usr/bin/env bash
echo "16 main 5432 online postgres /var/lib/postgresql/16/main /var/log/postgresql/postgresql-16-main.log"
STUB
cat >"$stubs/crontab" <<'STUB'
#!/usr/bin/env bash
echo "0 3 * * * /usr/local/bin/client-backup"
STUB
# the machine's addresses, as `ip -o addr show scope global` prints them on ths-prod-01
cat >"$stubs/ip" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"scope global"*)
    cat <<'DATA'
2: eth0    inet 203.0.113.10/32 metric 100 scope global dynamic eth0
2: eth0    inet6 2001:db8::10/64 scope global
6: tailscale0    inet 100.64.0.10/32 scope global tailscale0  scan-forbidden: allow-addresses (a Tailscale test address)
7: docker0    inet 172.16.0.1/16 brd 172.16.255.255 scope global docker0
DATA
    ;;
esac
STUB

# apparmor_parser: logs its call; STUB_AA_FAIL makes it fail. -r marks the profile loaded in the fake /sys list, -R unmarks it.
cat >"$stubs/apparmor_parser" <<'STUB'
#!/usr/bin/env bash
echo "apparmor_parser $*" >>"$STUB_LOG/calls"
if [ -n "${STUB_AA_FAIL:-}" ]; then echo "apparmor_parser: syntax error" >&2; exit 1; fi
loaded="$BULIG_DEPLOY_TEST_ROOT/sys/kernel/security/apparmor/profiles"
if [ -d "$(dirname "$loaded")" ]; then
  case "$1" in
    -r) grep -v '^bulig-bwrap ' "$loaded" >"$loaded.n" 2>/dev/null; echo "bulig-bwrap (unconfined)" >>"$loaded.n"; /bin/mv "$loaded.n" "$loaded" ;;
    -R) grep -v '^bulig-bwrap ' "$loaded" >"$loaded.n" 2>/dev/null; /bin/mv "$loaded.n" "$loaded" ;;
  esac
fi
exit 0
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
# install: logged (the unit files, the host drop-in and the AppArmor profile are all written with it), then the real one
cat >"$stubs/install" <<'STUB'
#!/usr/bin/env bash
echo "install $*" >>"$STUB_LOG/calls"
exec /usr/bin/install "$@"
STUB
cat >"$stubs/head" <<'STUB'
#!/usr/bin/env bash
echo "head $*" >>"$STUB_LOG/head"
exec /usr/bin/head "$@"
STUB
chmod +x "$stubs"/*
export STUB_SNAP="$work/snap"
mkdir -p "$STUB_SNAP"
printf 'nginx.service loaded active running A web server\nclientapp.service loaded active running Client app\n' >"$STUB_SNAP/units.txt"
printf 'nginx.service enabled\nclientapp.service enabled\n' >"$STUB_SNAP/unitfiles.txt"
: >"$STUB_SNAP/timers.txt"
printf 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))\n' >"$STUB_SNAP/ss.txt"
printf 'clientweb ghcr.io/client/web:1.4 running\n' >"$STUB_SNAP/docker.txt"
printf 'root:x:0:0:root:/root:/bin/bash\nclient:x:1000:1000::/home/client:/bin/bash\n' >"$STUB_SNAP/passwd.txt"
printf 'root:x:0:\nclient:x:1000:\n' >"$STUB_SNAP/group.txt"
# The system admin folders (/usr/sbin, /sbin) are reached through a copy of links that leaves out every AppArmor tool: on a Linux machine with
# AppArmor (CI runners included) the real apparmor_parser lives there, and no test may ever run it (as root it would load a profile into the
# real kernel). The release finds only the stand-in above, or, when a test removes the stand-in, nothing at all.
sbin="$work/sbin"
mkdir -p "$sbin"
for d in /usr/sbin /sbin; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do
    n="${f##*/}"
    case "$n" in apparmor_parser | aa-* | apparmor*) continue ;; esac
    if [ -x "$f" ] && [ ! -e "$sbin/$n" ]; then ln -s "$f" "$sbin/$n"; fi
  done
done
export PATH="$stubs:/usr/bin:/bin:$sbin"
# aa_guard: stop the whole suite if any apparmor_parser other than the stand-in could be found on PATH (or on /usr/bin, /bin, which stay).
aa_guard() {
  local d
  IFS=: read -r -a _dirs <<<"$PATH"
  for d in "${_dirs[@]}"; do
    [ "$d" = "$stubs" ] && continue
    if [ -e "$d/apparmor_parser" ]; then echo "  FAIL  the real apparmor_parser is reachable at $d/apparmor_parser: refusing to run a release test" >&2; exit 1; fi
  done
}
aa_guard

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
  cp -R "$deploy/apparmor" "$inc/deploy/"
  if [ -n "${STUB_PROFILE:-}" ]; then printf '%s\n' "$STUB_PROFILE" >"$inc/deploy/apparmor/bulig-bwrap"; fi
  cp "$deploy/postcheck.sh" "$inc/deploy/"
  if [ "$hx" = "tenant" ]; then
    # healthy, but while the release ran another tenant started a service listening on loopback
    printf '#!/usr/bin/env bash\necho "LISTEN 0 4096 127.0.0.1:9999 0.0.0.0:* users:((\\"other\\",pid=4,fd=3))" >>"%s"\n' "$STUB_SNAP/ss.txt" >"$inc/deploy/health.sh"
  elif [ "$hx" = "flag" ]; then
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
  aa_guard
  bash "$2/deploy/release-remote.sh" "$1" 5
}
link_of() { readlink "$1" 2>/dev/null | xargs -I{} basename {}; }
releases_list() { find "$r/opt/bulig/releases" -mindepth 1 -maxdepth 1 | sort | tr '\n' ' '; }
# (the release-<sha>.before.snapshot files are meant to stay: section 1c checks them)
leftovers() { find "$r/var/lib/bulig-checks" -mindepth 1 -maxdepth 1 ! -name 'release-*.before.snapshot' | head -3; }
snapshots() { (cd "$r/var/lib/bulig-checks" && find . -maxdepth 1 -name 'release-*.before.snapshot' | sed 's#^\./##' | sort | tr '\n' ' '); }

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
# A dependency's install script may make a hard link (esbuild does, found on the server 20 Oct 2026). The build archives
# it as a separate file, so the unpack check can keep refusing hard links without refusing the release.
if grep -q "tar -c --hard-dereference --null -T - -f -" "$deploy/release-remote.sh"; then ok "the build archives hard links as separate files (--hard-dereference)"; else bad "the build tar does not dereference hard links, so esbuild's install makes every release fail"; fi

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
if grep -q "apparmor: not enabled on this machine" "$work/out" && [ ! -e "$r/etc/apparmor.d/bulig-bwrap" ] && ! grep -q "^apparmor_parser" "$STUB_LOG/calls"; then ok "where AppArmor is not enabled, the profile is skipped with a note (nothing written, apparmor_parser not run)"; else bad "apparmor without AppArmor: $(grep apparmor "$work/out" "$STUB_LOG/calls")"; fi
build_call="$(grep -- '--unit=bulig-build-' "$STUB_LOG/calls" | head -1)"
extract_call="$(grep -- '--unit=bulig-extract-' "$STUB_LOG/calls" | head -1)"
for p in DynamicUser=yes PrivateTmp=yes KillMode=control-group ProtectSystem=strict NoNewPrivileges=yes MemoryMax= TasksMax=; do
  case "$build_call" in *"$p"*) ok "the build unit has $p" ;; *) bad "the build unit lacks $p: $build_call" ;; esac
done
DENY="127.0.0.0/8 ::1/128 169.254.0.0/16 fe80::/10 224.0.0.0/4 ff00::/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7 198.18.0.0/15"
case "$build_call" in *"-p IPAddressDeny=$DENY 2001:db8::10/128 203.0.113.10/32 -p "*) ok "the build cannot reach localhost, link-local, multicast, private ranges, Tailscale, the docker bridges or this machine's own public addresses (read from ip at run time)" ;; *) bad "the build's IPAddressDeny: $build_call" ;; esac
case "$build_call" in *"IPAddressAllow"*) bad "the build allows an address: $build_call" ;; *) ok "and the build allows no address at all (not even the DNS stub)" ;; esac
case "$build_call" in *"-p RestrictAddressFamilies=AF_INET AF_INET6 -p "*) ok "the build gets IP sockets only: no AF_UNIX, so a tenant's abstract socket is out of reach" ;; *) bad "the build's address families: $build_call" ;; esac
case "$build_call" in *"-p InaccessiblePaths=-/run/tailscale -/run/snapd.socket -/run/docker.sock -/var/run/docker.sock "*) ok "the build cannot see the tailscale, snapd or docker sockets" ;; *) bad "the build's InaccessiblePaths: $build_call" ;; esac
case "$build_call" in *"-p BindReadOnlyPaths=/run/systemd/resolve/resolv.conf:/etc/resolv.conf "*) ok "the build resolves names through resolved's upstream list, not the 127.0.0.53 stub" ;; *) bad "the build's resolver: $build_call" ;; esac
wd="$r/etc/systemd/system/bulig-worker.service.d/10-host-addresses.conf"
if [ -f "$wd" ] && grep -qx "IPAddressDeny=2001:db8::10/128 203.0.113.10/32" "$wd"; then ok "each release refreshes the worker's drop-in with the machine's current public addresses"; else bad "worker drop-in: $(cat "$wd" 2>&1)"; fi
pd="$r/etc/systemd/system/bulig-pasta.service.d/10-host-addresses.conf"
if [ -f "$pd" ] && grep -qx "IPAddressDeny=2001:db8::10/128 203.0.113.10/32" "$pd"; then ok "and pasta's (the worker's packets leave the host as pasta's)"; else bad "pasta drop-in: $(cat "$pd" 2>&1)"; fi
case "$build_call" in *"--uid="* | *" -p User="*) bad "the build is tied to a named user: $build_call" ;; *) ok "the build runs as a throwaway user, not as bulig or bulig-worker" ;; esac
case "$build_call" in *"$r"* | *"/var/lib/bulig-checks"* | *"/usr/local/lib/bulig"*) bad "a path of root's trees reached the build's arguments: $build_call" ;; *) ok "no path of root's trees is in the build's arguments (the source goes in on stdin)" ;; esac
seqA="$(grep -E '^systemctl (enable|disable|stop|start|restart) ' "$STUB_LOG/calls" | tr '\n' '|')"
if [ "$seqA" = "systemctl enable bulig-loopback.service bulig-netns.service bulig-pasta.service bulig.service bulig-worker.service|systemctl stop bulig-worker.service|systemctl restart bulig-loopback.service|systemctl restart bulig-netns.service bulig-pasta.service|systemctl restart bulig.service bulig-worker.service|" ]; then ok "the five units are enabled; the worker is stopped, the gateway addresses restarted (a start would not add 198.18.74.1), the namespace made fresh and pasta started, then the kernel and the worker restarted, in that order"; else bad "systemctl order: $seqA"; fi
if grep -q "^config: .* already listens on 198.18.74.1" "$work/out"; then ok "the config made from the template already listens on 198.18.74.1, and is left as it is"; else bad "config note: $(grep '^config' "$work/out")"; fi
for p in "ReadWritePaths=$r/var/lib/bulig-checks/rel." ProtectSystem=strict PrivateNetwork=yes CapabilityBoundingSet= NoNewPrivileges=yes ProtectKernelTunables=yes ProtectControlGroups=yes ProtectKernelModules=yes ProtectKernelLogs=yes ProtectClock=yes; do
  case "$extract_call" in *"$p"*) ok "the unpack unit has $p" ;; *) bad "the unpack unit lacks $p: $extract_call" ;; esac
done
rw_values="$(grep -o 'ReadWritePaths=[^ ]*' <<<"$extract_call")"
if [ "$(printf '%s\n' "$rw_values" | wc -l | tr -d ' ')" = "1" ] && case "$rw_values" in *"/mods") true ;; *) false ;; esac; then ok "the unpack unit can write one folder only (the empty mods folder)"; else bad "unpack writable paths: $rw_values"; fi

# the before snapshot: taken after the build, before the first change to the host, kept root-only; the comparison after health passes
snapA="$r/var/lib/bulig-checks/release-$A.before.snapshot"
first_snap="$(grep -n '^systemctl list-units' "$STUB_LOG/calls" | head -1 | cut -d: -f1)"
build_line="$(grep -n -- '--unit=bulig-build-' "$STUB_LOG/calls" | head -1 | cut -d: -f1)"
first_change="$(grep -n '^systemctl daemon-reload' "$STUB_LOG/calls" | head -1 | cut -d: -f1)"
if [ -f "$snapA" ] && [ "$(mode "$snapA")" = "600" ] && grep -q '^nginx.service enabled$' "$snapA"; then ok "the release saved its before snapshot as release-<sha>.before.snapshot, mode 600"; else bad "before snapshot: $(ls -l "$r/var/lib/bulig-checks")"; fi
first_write="$(grep -n "^install .*$r/etc/" "$STUB_LOG/calls" | head -1 | cut -d: -f1)"
if [ -n "$first_snap" ] && [ "$first_snap" -gt "${build_line:-999999}" ] && [ "$first_snap" -lt "${first_write:-0}" ] && [ "$first_snap" -lt "${first_change:-0}" ]; then ok "it is taken after the build and before the first write under /etc (unit files, drop-in, AppArmor) and the reload (calls $build_line < $first_snap < $first_write, $first_change)"; else bad "snapshot order: build $build_line, snapshot $first_snap, first /etc write $first_write, daemon-reload $first_change"; fi
if grep -q "^release: postcheck after the health check, against $snapA" "$work/out" && grep -q "^release: postcheck ok" "$work/out" && grep -q "^postcheck: the snapshot matches release-$A.before.snapshot" "$work/out"; then ok "after the health check the host is compared with it, and the result is reported"; else bad "release postcheck output: $(grep -i postcheck "$work/out")"; fi
if [ "$(grep -n '^release: healthy on' "$work/out" | cut -d: -f1)" -lt "$(grep -n '^release: postcheck after' "$work/out" | cut -d: -f1)" ]; then ok "and only once health passed"; else bad "postcheck before health: $(grep -n 'healthy on\|postcheck after' "$work/out")"; fi

if grep -qx "head -c $((2 * 1024 * 1024 * 1024 + 1))" "$STUB_LOG/head"; then ok "the build's output is cut at the cap plus one byte on the stream, before it is written (head -c 2 GiB + 1)"; else bad "head calls: $(cat "$STUB_LOG/head" 2>&1)"; fi

# --- 2. an unhealthy release rolls back ---
echo "release B (health check fails)"
incB="$(deliver "$B" 1)"
expect_fail_msg "a failed health check fails the release" "FAILED" run_remote "$B" "$incB"
if [ "$(link_of "$r/opt/bulig/current")" = "$A" ] && [ "$(link_of "$r/usr/local/lib/bulig/current")" = "$A" ]; then ok "both links are back on the previous release"; else bad "links after rollback: $(readlink "$r/opt/bulig/current") $(readlink "$r/usr/local/lib/bulig/current")"; fi
if grep -q "version $A" "$r/etc/systemd/system/bulig.service"; then ok "the unit files are back to the previous release's"; else bad "unit file after rollback: $(cat "$r/etc/systemd/system/bulig.service")"; fi
if user_folders_untouched; then ok "a rollback leaves the user folders alone too"; else bad "a user folder changed during the rollback"; fi
if [ -z "$(leftovers)" ]; then ok "and leaves nothing behind"; else bad "left: $(leftovers)"; fi
if grep -q "^release: postcheck after the rollback, against $r/var/lib/bulig-checks/release-$B.before.snapshot" "$work/out" && grep -q "^release: postcheck ok" "$work/out"; then ok "after the rollback the host is compared with the snapshot taken before it, and it matches"; else bad "rollback postcheck: $(grep -i postcheck "$work/out")"; fi

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
if [ ! -e "$r/var/lib/bulig-checks/release-cafecafecafe.before.snapshot" ]; then ok "a release refused before it changed anything takes no snapshot"; else bad "a refused release left a before snapshot"; fi
if [ "$(readlink "$r/opt/bulig/current")" = "$r/opt/bulig/releases/$A" ] && [ ! -e "$r/usr/local/lib/bulig/cafecafecafe" ]; then ok "and nothing was installed"; else bad "state after a failed build"; fi

# --- 4c. the before snapshot and the comparison after health ---
echo "the before snapshot"
# another tenant changes something while the release runs: reported loudly, never rolled back for (health decides the release)
T="7e7e7e7e7e7e"
incT="$(deliver "$T" tenant)"
run_remote "$T" "$incT" >"$work/out" 2>&1
rc=$?
if [ "$rc" -eq 0 ] && [ "$(link_of "$r/opt/bulig/current")" = "$T" ] && [ "$(cat "$r/opt/bulig/.healthy-sha")" = "$T" ] && ! grep -q "rolling back" "$work/out"; then ok "a change by someone else during the release does not fail it or roll it back (exit 0, live, marked healthy)"; else bad "tenant change rc=$rc: $(cat "$work/out")"; fi
if grep -q "^release: WARNING: POSTCHECK FAILED after the health check" "$work/out" && grep -qF '+127.0.0.1:9999 users:(("other"))' "$work/out"; then ok "but it is reported loudly, with the diff that names it"; else bad "tenant change report: $(grep -i 'postcheck\|9999' "$work/out")"; fi
# the snapshot cannot be taken: the release goes on, and says the comparison was skipped
U="7f7f7f7f7f7f"
incU="$(deliver "$U" 0)"
STUB_SS_FAIL=1 run_remote "$U" "$incU" >"$work/out" 2>&1
rc=$?
if [ "$rc" -eq 0 ] && [ "$(link_of "$r/opt/bulig/current")" = "$U" ] && grep -q "could not take the before snapshot" "$work/out" && grep -q "^release: postcheck skipped after the health check" "$work/out"; then ok "a snapshot that fails does not stop the release, and the skipped comparison is said"; else bad "failed snapshot rc=$rc: $(cat "$work/out")"; fi
if [ ! -e "$r/var/lib/bulig-checks/release-$U.before.snapshot" ] && [ -z "$(leftovers)" ]; then ok "and it leaves no partial snapshot and no temp file"; else bad "after a failed snapshot: $(snapshots) $(leftovers)"; fi
# only the newest five are kept
for n in 1 2 3 4 5 6; do cp "$r/var/lib/bulig-checks/release-$A.before.snapshot" "$r/var/lib/bulig-checks/release-00000000000$n.before.snapshot"; touch -t "20200101000$n" "$r/var/lib/bulig-checks/release-00000000000$n.before.snapshot"; done
touch -t 201901010000 "$r/var/lib/bulig-checks/release-$A.before.snapshot" "$r/var/lib/bulig-checks/release-$B.before.snapshot" "$r/var/lib/bulig-checks/release-$C.before.snapshot" "$r/var/lib/bulig-checks/release-$T.before.snapshot"
V="7d7d7d7d7d7d"
incV="$(deliver "$V" 0)"
expect_ok "a release with older snapshots around runs" run_remote "$V" "$incV"
if [ "$(snapshots)" = "release-000000000003.before.snapshot release-000000000004.before.snapshot release-000000000005.before.snapshot release-000000000006.before.snapshot release-$V.before.snapshot " ]; then ok "it keeps its own and the four newest before it, and removes the older ones"; else bad "snapshots kept: $(snapshots)"; fi
# files dated ahead of the clock: the new snapshot is still never pruned
for n in 1 2 3 4 5; do cp "$r/var/lib/bulig-checks/release-$V.before.snapshot" "$r/var/lib/bulig-checks/release-99999999999$n.before.snapshot"; touch -t "20990101000$n" "$r/var/lib/bulig-checks/release-99999999999$n.before.snapshot"; done
W="7c7c7c7c7c7c"
incW="$(deliver "$W" 0)"
expect_ok "a release with five snapshots dated ahead of the clock runs" run_remote "$W" "$incW"
if [ -f "$r/var/lib/bulig-checks/release-$W.before.snapshot" ] && grep -q "^release: postcheck ok" "$work/out" && [ "$(snapshots)" = "release-$W.before.snapshot release-999999999991.before.snapshot release-999999999992.before.snapshot release-999999999993.before.snapshot release-999999999994.before.snapshot release-999999999995.before.snapshot " ]; then ok "and its own snapshot is kept and used, while the older ones go"; else bad "with future-dated files: $(snapshots)"; fi
rm -f "$r/var/lib/bulig-checks"/release-99999999999?.before.snapshot
# a prune that fails is a warning: the new snapshot stays and is compared against
mkdir -p "$r/var/lib/bulig-checks/release-0000000000aa.before.snapshot/x"
touch -t 201801010000 "$r/var/lib/bulig-checks/release-0000000000aa.before.snapshot"
for n in 1 2 3 4 5; do cp "$r/var/lib/bulig-checks/release-$W.before.snapshot" "$r/var/lib/bulig-checks/release-00000000001$n.before.snapshot"; done
X="7b7b7b7b7b7b"
incX="$(deliver "$X" 0)"
expect_ok "a release whose prune fails still runs" run_remote "$X" "$incX"
if grep -q "could not prune the older before snapshots" "$work/out" && [ -f "$r/var/lib/bulig-checks/release-$X.before.snapshot" ] && grep -q "^release: postcheck after the health check, against $r/var/lib/bulig-checks/release-$X.before.snapshot" "$work/out" && grep -q "^release: postcheck ok" "$work/out"; then ok "a prune that fails is a warning, and the new snapshot is kept and compared against"; else bad "failed prune: $(grep -i 'prune\|postcheck' "$work/out") / $(snapshots)"; fi
rm -rf "$r/var/lib/bulig-checks/release-0000000000aa.before.snapshot"

# --- 5. a config that is already there is never overwritten ---
echo "release E (existing config)"
echo '{"edited":"by hand"}' >"$r/etc/bulig/config.json"
incE="$(deliver "eeeeeeeeeeee" 0)"
expect_ok "a second release runs" run_remote "eeeeeeeeeeee" "$incE"
if grep -q '"edited"' "$r/etc/bulig/config.json"; then ok "the config edited by hand is kept"; else bad "the config was overwritten"; fi
if [ "$(cat "$r/etc/bulig/config.json")" = '{"edited":"by hand"}' ] && grep -q "config: WARNING: .* has no pluginConfig.worker-gateway.listen list" "$work/out"; then ok "a config with no listen list is left byte for byte as it was, with a warning that says what to add"; else bad "no-listen config: $(cat "$r/etc/bulig/config.json") $(grep '^config' "$work/out")"; fi

# --- 5b. the kernel's gateway on 198.18.74.1: added to the listen list once, by the release, and put back by a rollback ---
echo "the gateway address in the config"
python3 -I -c '
import json, sys
c = {"store": {"kind": "postgres"}, "pluginConfig": {"worker-gateway": {"listen": ["127.74.3.1"], "port": 7431, "workers": {"vps": {"credential": "worker-tokens"}}}, "github": {"authorName": "Hand Edited"}}, "enabled": ["worker-gateway"]}
open(sys.argv[1], "w").write(json.dumps(c, indent=4) + "\n")
' "$r/etc/bulig/config.json"
chmod 600 "$r/etc/bulig/config.json"
cp -p "$r/etc/bulig/config.json" "$work/cfg.old"
incN="$(deliver "c1c1c1c1c1c1" 0)"
expect_ok "a release over a config without 198.18.74.1 runs" run_remote "c1c1c1c1c1c1" "$incN"
if python3 -I -c '
import json, sys
old, new = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
assert new["pluginConfig"]["worker-gateway"]["listen"] == ["127.74.3.1", "198.18.74.1"], new
new["pluginConfig"]["worker-gateway"]["listen"] = ["127.74.3.1"]
assert new == old, (old, new)
' "$work/cfg.old" "$r/etc/bulig/config.json" 2>"$work/err"; then ok "it adds 198.18.74.1 after 127.74.3.1 in the listen list and changes nothing else"; else bad "config after the release: $(cat "$work/err")"; fi
if [ "$(mode "$r/etc/bulig/config.json")" = "600" ] && grep -q "^config: added 198.18.74.1 to pluginConfig.worker-gateway.listen" "$work/out" && [ -z "$(find "$r/etc/bulig" -name '.config.*')" ]; then ok "and keeps it mode 600, says so, and leaves no temp file"; else bad "config mode or note: $(mode "$r/etc/bulig/config.json") $(grep '^config' "$work/out")"; fi
cp -p "$r/etc/bulig/config.json" "$work/cfg.new"
incN2="$(deliver "c2c2c2c2c2c2" 0)"
expect_ok "the next release runs" run_remote "c2c2c2c2c2c2" "$incN2"
if cmp -s "$work/cfg.new" "$r/etc/bulig/config.json" && grep -q "already listens on 198.18.74.1" "$work/out"; then ok "and leaves the config as it is (the address is there once)"; else bad "config changed again: $(cat "$r/etc/bulig/config.json")"; fi
cp -p "$work/cfg.old" "$r/etc/bulig/config.json"
: >"$STUB_LOG/calls"
incN3="$(deliver "c3c3c3c3c3c3" 1)"
expect_fail_msg "a release that adds the address and then fails its health check fails" "FAILED" run_remote "c3c3c3c3c3c3" "$incN3"
if cmp -s "$work/cfg.old" "$r/etc/bulig/config.json" && [ "$(mode "$r/etc/bulig/config.json")" = "600" ]; then ok "the rollback puts the config back byte for byte (the release before refuses 198.18.74.1)"; else bad "config after the rollback: $(cat "$r/etc/bulig/config.json")"; fi
seqR="$(grep -E '^systemctl (enable|disable|stop|start|restart) ' "$STUB_LOG/calls" | tr '\n' '|')"
case "$seqR" in *"|systemctl stop bulig-worker.service bulig.service bulig-pasta.service bulig-netns.service bulig-loopback.service|systemctl start bulig-loopback.service|systemctl restart bulig.service bulig-worker.service|") ok "the rollback stops all five units (the new files still loaded), starts the previous gateway addresses, then restarts the kernel and the worker" ;; *) bad "rollback order: $seqR" ;; esac
case "$seqR" in *"systemctl disable"*) bad "the rollback disabled a unit the previous release has: $seqR" ;; *) ok "and disables nothing the previous release has" ;; esac
mv "$r/etc/bulig/config.json" "$work/cfg.keep"
ln -s "$work/cfg.keep" "$r/etc/bulig/config.json"
incN4="$(deliver "c4c4c4c4c4c4" 0)"
expect_fail_msg "a link where the config belongs fails the release" "is missing or a link" run_remote "c4c4c4c4c4c4" "$incN4"
rm -f "$r/etc/bulig/config.json"
mv "$work/cfg.keep" "$r/etc/bulig/config.json"
printf '{not json' >"$r/etc/bulig/config.json"
incN5="$(deliver "c5c5c5c5c5c5" 0)"
expect_fail_msg "a config that is not JSON fails the release" "could not be read as JSON" run_remote "c5c5c5c5c5c5" "$incN5"
if [ "$(cat "$r/etc/bulig/config.json")" = "{not json" ] && [ -z "$(find "$r/etc/bulig" -name '.config.*')" ]; then ok "and it is left as it was, with no temp file"; else bad "bad config after: $(cat "$r/etc/bulig/config.json")"; fi
cp -p "$work/cfg.new" "$r/etc/bulig/config.json"

# --- 5c. a rollback to a release that had no namespace units: the units this release added are stopped, disabled and removed ---
echo "a rollback to a release without the namespace"
live_ns="$(readlink "$r/opt/bulig/current")"
rm -f "$r/etc/systemd/system/bulig-netns.service" "$r/etc/systemd/system/bulig-pasta.service"
: >"$STUB_LOG/calls"
incQ="$(deliver "c6c6c6c6c6c6" 1)"
expect_fail_msg "a release that adds the namespace units and fails its health check fails" "FAILED" run_remote "c6c6c6c6c6c6" "$incQ"
seqQ="$(grep -E '^systemctl (enable|disable|stop|start|restart) ' "$STUB_LOG/calls" | tr '\n' '|')"
case "$seqQ" in *"|systemctl stop bulig-worker.service bulig.service bulig-pasta.service bulig-netns.service bulig-loopback.service|systemctl disable bulig-netns.service|systemctl disable bulig-pasta.service|systemctl start bulig-loopback.service|systemctl restart bulig.service bulig-worker.service|") ok "the rollback stops all five, disables the two units the previous release did not have, and only then starts it again" ;; *) bad "rollback without the namespace: $seqQ" ;; esac
if [ ! -e "$r/etc/systemd/system/bulig-netns.service" ] && [ ! -e "$r/etc/systemd/system/bulig-pasta.service" ] && [ "$(readlink "$r/opt/bulig/current")" = "$live_ns" ]; then ok "and removes their unit files, and the links are back"; else bad "after the rollback: $(ls "$r/etc/systemd/system") $(readlink "$r/opt/bulig/current")"; fi

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
if grep -q "^systemctl disable bulig-loopback.service bulig-netns.service bulig-pasta.service bulig.service bulig-worker.service" "$STUB_LOG/calls" && grep -q "^systemctl stop bulig-worker.service bulig.service bulig-pasta.service bulig-netns.service bulig-loopback.service" "$STUB_LOG/calls"; then ok "both services, the worker's namespace, pasta and the gateway addresses are stopped and disabled, so a reboot starts nothing"; else bad "systemctl calls: $(grep systemctl "$STUB_LOG/calls")"; fi
if grep -q "^postcheck: no Bulig unit is installed, and Bulig left nothing on the host's network" "$work/out"; then ok "and the postcheck after it checks that nothing of Bulig's is left on the host's network"; else bad "no network leftover check after the failed first release: $(grep -i postcheck "$work/out")"; fi
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

# --- 6c. bwrap's AppArmor profile ---
echo "the AppArmor profile for bubblewrap"
AAP="$r/etc/apparmor.d/bulig-bwrap"
LOADED="$r/sys/kernel/security/apparmor/profiles"
mkdir -p "$r/sys/module/apparmor/parameters" "$(dirname "$LOADED")" "$r/etc/apparmor.d"
echo Y >"$r/sys/module/apparmor/parameters/enabled"
: >"$LOADED"
echo "# someone else's profile" >"$r/etc/apparmor.d/usr.bin.other"
cp -p "$r/etc/apparmor.d/usr.bin.other" "$work/other.keep"
aa_calls() { grep '^apparmor_parser' "$STUB_LOG/calls" | tr '\n' '|'; }
live() { link_of "$r/opt/bulig/current"; }
: >"$STUB_LOG/calls"
incH1="$(deliver "a1a1a1a1a1a1" 0)"
expect_ok "a release with AppArmor enabled runs" run_remote "a1a1a1a1a1a1" "$incH1"
if [ -f "$AAP" ] && cmp -s "$AAP" "$deploy/apparmor/bulig-bwrap" && [ "$(mode "$AAP")" = "644" ]; then ok "the profile is installed as shipped, mode 644"; else bad "profile: $(mode "$AAP" 2>&1)"; fi
if [ "$(aa_calls)" = "apparmor_parser -r $AAP|" ]; then ok "and loaded once with apparmor_parser -r"; else bad "apparmor_parser calls: $(aa_calls)"; fi
if cmp -s "$r/etc/apparmor.d/usr.bin.other" "$work/other.keep" && [ "$(find "$r/etc/apparmor.d" -type f | wc -l | tr -d ' ')" = "2" ]; then ok "and no other file in /etc/apparmor.d is touched or added"; else bad "/etc/apparmor.d: $(find "$r/etc/apparmor.d" -type f)"; fi
if user_folders_untouched; then ok "and the user folders are untouched"; else bad "a user folder changed"; fi
: >"$STUB_LOG/calls"
incH2="$(deliver "a2a2a2a2a2a2" 0)"
run_remote "a2a2a2a2a2a2" "$incH2" >"$work/out" 2>&1
if [ "$(live)" = "a2a2a2a2a2a2" ] && [ -z "$(aa_calls)" ] && grep -q "is as in the release and loaded" "$work/out"; then ok "a release whose profile is already installed and loaded writes nothing and does not reload it"; else bad "unchanged profile: $(aa_calls) $(cat "$work/out")"; fi
: >"$LOADED"
: >"$STUB_LOG/calls"
incH3="$(deliver "a3a3a3a3a3a3" 0)"
run_remote "a3a3a3a3a3a3" "$incH3" >"$work/out" 2>&1
if [ "$(live)" = "a3a3a3a3a3a3" ] && [ "$(aa_calls)" = "apparmor_parser -r $AAP|" ] && grep -q "but not loaded; loaded it" "$work/out"; then ok "a profile that is right on disk but not loaded is loaded"; else bad "not-loaded profile: $(aa_calls) $(cat "$work/out")"; fi
# a release whose health check fails puts the previous profile back and reloads it
echo "# the previous profile" >"$AAP"
cp -p "$AAP" "$work/aa.prev"
: >"$STUB_LOG/calls"
incH4="$(deliver "a4a4a4a4a4a4" 1)"
expect_fail_msg "a release that changes the profile and then fails its health check fails" "FAILED" run_remote "a4a4a4a4a4a4" "$incH4"
if cmp -s "$AAP" "$work/aa.prev" && [ "$(live)" = "a3a3a3a3a3a3" ]; then ok "the rollback puts the previous profile back (and the links)"; else bad "after rollback: $(cat "$AAP") / $(live)"; fi
if [ "$(aa_calls)" = "apparmor_parser -r $AAP|apparmor_parser -r $AAP|" ]; then ok "and reloads it"; else bad "rollback calls: $(aa_calls)"; fi
# apparmor_parser fails: the release fails and rolls back
: >"$STUB_LOG/calls"
incH5="$(deliver "a5a5a5a5a5a5" 0)"
STUB_AA_FAIL=1 run_remote "a5a5a5a5a5a5" "$incH5" >"$work/out" 2>&1
rc=$?
if [ "$rc" -ne 0 ] && grep -q "apparmor_parser -r $AAP failed" "$work/out" && grep -q "rolling back" "$work/out" && [ "$(live)" = "a3a3a3a3a3a3" ]; then ok "a profile apparmor_parser refuses fails the release, which rolls back"; else bad "parser failure rc=$rc: $(cat "$work/out")"; fi
if cmp -s "$AAP" "$work/aa.prev"; then ok "and the previous profile is back on disk"; else bad "profile after a parser failure: $(cat "$AAP")"; fi
first_aa="$(grep -n '^apparmor_parser -r' "$STUB_LOG/calls" | head -1 | cut -d: -f1)"
first_restart="$(grep -n '^systemctl restart bulig.service bulig-worker.service' "$STUB_LOG/calls" | head -1 | cut -d: -f1)"
if [ "$(grep -c '^systemctl restart bulig.service bulig-worker.service' "$STUB_LOG/calls")" = "1" ] && [ -n "$first_aa" ] && [ "$first_aa" -lt "${first_restart:-0}" ]; then ok "and the services were restarted only once, by the rollback (the profile is loaded before the new release starts)"; else bad "restarts around the profile: $(grep -n 'apparmor_parser\|systemctl restart' "$STUB_LOG/calls")"; fi
# no profile before, and the release fails: the profile is unloaded and removed
rm -f "$AAP"
: >"$STUB_LOG/calls"
incH6="$(deliver "a6a6a6a6a6a6" 1)"
expect_fail_msg "a release that adds the profile and fails its health check fails" "FAILED" run_remote "a6a6a6a6a6a6" "$incH6"
if [ ! -e "$AAP" ] && [ "$(aa_calls)" = "apparmor_parser -r $AAP|apparmor_parser -R $AAP|" ]; then ok "and the profile it added is unloaded (apparmor_parser -R) and removed"; else bad "after a failed first install: $(ls "$AAP" 2>&1) $(aa_calls)"; fi
# a link where the profile belongs is refused, and the release rolls back
ln -s "$work/aa.prev" "$AAP"
incH7="$(deliver "a7a7a7a7a7a7" 0)"
expect_fail_msg "a link where the profile belongs fails the release" "is a link. Not touching it." run_remote "a7a7a7a7a7a7" "$incH7"
if [ -L "$AAP" ] && cmp -s "$work/aa.prev" <(echo "# the previous profile") && [ "$(live)" = "a3a3a3a3a3a3" ]; then ok "and neither the link nor its target is changed, and the links are back"; else bad "after a link: $(ls -l "$AAP") $(live)"; fi
rm -f "$AAP"
# a link to a file that already matches the release is refused too (it must not count as "already installed")
cp "$deploy/apparmor/bulig-bwrap" "$work/aa.same"
ln -s "$work/aa.same" "$AAP"
incH7b="$(deliver "a7b7a7b7a7b7" 0)"
expect_fail_msg "a link to a matching profile fails the release too" "is a link. Not touching it." run_remote "a7b7a7b7a7b7" "$incH7b"
rm -f "$AAP"
# AppArmor on, but no apparmor_parser
mv "$stubs/apparmor_parser" "$work/aa-stub"
if [ -z "$(command -v apparmor_parser)" ]; then ok "with the stand-in removed, no apparmor_parser at all is on the test PATH (the real one is never reached)"; else bad "an apparmor_parser is still reachable: $(command -v apparmor_parser)"; exit 1; fi
incH8="$(deliver "a8a8a8a8a8a8" 0)"
expect_fail_msg "AppArmor enabled without apparmor_parser fails the release" "apparmor_parser is not installed" run_remote "a8a8a8a8a8a8" "$incH8"
mv "$work/aa-stub" "$stubs/apparmor_parser"
if [ ! -e "$AAP" ] && [ "$(live)" = "a3a3a3a3a3a3" ]; then ok "and nothing is written"; else bad "after a missing parser: $(ls "$AAP" 2>&1) $(live)"; fi
# a release that ships a different profile replaces the installed one
cp "$deploy/apparmor/bulig-bwrap" "$AAP"
: >"$STUB_LOG/calls"
incH9="$(STUB_PROFILE='# a newer profile' deliver "a9a9a9a9a9a9" 0)"
expect_ok "a release with a changed profile runs" run_remote "a9a9a9a9a9a9" "$incH9"
if grep -qx '# a newer profile' "$AAP" && [ "$(aa_calls)" = "apparmor_parser -r $AAP|" ]; then ok "and the installed profile is replaced and reloaded"; else bad "changed profile: $(cat "$AAP") $(aa_calls)"; fi
if user_folders_untouched && [ -z "$(leftovers)" ]; then ok "and the user folders and /var/lib/bulig-checks are clean after all of it"; else bad "dirty after the AppArmor cases: $(leftovers)"; fi
# a failed FIRST release (nothing to go back to) that added the profile unloads and removes it as well
wipe_root
rm -f "$AAP"
: >"$LOADED"
: >"$STUB_LOG/calls"
incH10="$(deliver "b1b1b1b1b1b1" 1)"
expect_fail_msg "a first release that adds the profile and fails its health check fails" "no healthy release to go back to" run_remote "b1b1b1b1b1b1" "$incH10"
if [ ! -e "$AAP" ] && [ "$(aa_calls)" = "apparmor_parser -r $AAP|apparmor_parser -R $AAP|" ] && ! grep -q '^bulig-bwrap ' "$LOADED"; then ok "and the profile it added is unloaded and removed"; else bad "after a failed first release: $(ls "$AAP" 2>&1) $(aa_calls)"; fi
rm -rf "$r/sys" "$r/etc/apparmor.d"

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
