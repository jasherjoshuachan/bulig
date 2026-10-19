#!/usr/bin/env bash
# Tests for release-remote.sh (the server half of a release) with a stubbed systemd, a stubbed dependency install and a throwaway root.
# They prove the structure, not just the happy path:
#   - the scripts root runs live in a root tree that bulig's install never saw;
#   - a build script that edits a file, adds a file, or keeps a file open and writes later cannot change the live release;
#   - a failed health check, or a failed unit install after the symlinks moved, puts back both symlinks and the unit files;
#   - a sha that is already live is refused.
# shellcheck disable=SC1091,SC2030,SC2031,SC2154
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

r="$work/r"
stubs="$work/stubs"
mkdir -p "$stubs" "$r/opt/bulig/releases" "$r/usr/local/lib/bulig" "$r/etc/systemd/system" "$r/var/lib/bulig/.bulig"
export BULIG_DEPLOY_TEST_ROOT="$r"
export STUB_LOG="$work/log"
mkdir -p "$STUB_LOG"
UNITS="bulig.service bulig-worker.service bulig-backup.service bulig-backup.timer bulig-restore-drill.service bulig-restore-drill.timer"

# --- stubs ---
# systemd-run: plays the dependency install. It writes node_modules AND misbehaves the way a hostile build script could:
# edits a tracked file, adds a file, and keeps a file open to write into it a moment later.
cat >"$stubs/systemd-run" <<'STUB'
#!/usr/bin/env bash
echo "systemd-run $*" >>"$STUB_LOG/calls"
build=""
for a in "$@"; do case "$a" in --working-directory=*) build="${a#--working-directory=}" ;; esac; done
[ -d "$build" ] || exit 1
mkdir -p "$build/node_modules/dep" "$build/packages/cli/node_modules/x"
echo "module.exports = 1" >"$build/node_modules/dep/index.js"
echo "x" >"$build/packages/cli/node_modules/x/index.js"
if [ -n "${STUB_TAMPER:-}" ]; then
  echo "evil" >>"$build/packages/cli/bin/bulig.mjs"
  echo "evil" >"$build/evil.sh"
  ( exec 7>>"$build/packages/core/index.js"; sleep 2; echo "late write" >&7 ) </dev/null >/dev/null 2>&1 &
fi
exit 0
STUB
cat >"$stubs/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "systemctl $*" >>"$STUB_LOG/calls"
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
chmod +x "$stubs"/*
export PATH="$stubs:/usr/bin:/bin:/usr/sbin:/sbin"

# deliver <short> <n> <health-exit> [missing-unit]: put the two delivered trees where release.sh's rsync would, root tree and node tree.
deliver() {
  local short="$1" n="$2" hx="$3" missing="${4:-}" name node tk u
  name=".incoming-$short-$n"
  node="$r/opt/bulig/releases/$name"
  tk="$r/usr/local/lib/bulig/$name"
  rm -rf "$node" "$tk"
  mkdir -p "$node/packages/cli/bin" "$node/packages/core" "$tk/systemd"
  echo "lock" >"$node/pnpm-lock.yaml"
  echo "{}" >"$node/package.json"
  echo "console.log('cli $short')" >"$node/packages/cli/bin/bulig.mjs"
  echo "module.exports = '$short'" >"$node/packages/core/index.js"
  printf '#!/usr/bin/env bash\nexit %s\n' "$hx" >"$tk/health.sh"
  echo '#!/usr/bin/env bash' >"$tk/backup-postgres.sh"
  chmod 755 "$tk/health.sh" "$tk/backup-postgres.sh"
  echo '{"store":{"kind":"postgres"}}' >"$tk/bulig.config.vps.json"
  for u in $UNITS; do
    [ "$u" = "$missing" ] || printf '[Unit]\n# version %s\n' "$short" >"$tk/systemd/$u"
  done
  echo "$name"
}
run_remote() { # run_remote <short> <name>: what `ssh host bash -s -- ...` runs
  bash "$deploy/release-remote.sh" "$1" 5 "$2"
}
link_of() { readlink "$1" 2>/dev/null | xargs -I{} basename {}; }

A="aaaaaaaaaaaa"; B="bbbbbbbbbbbb"; C="cccccccccccc"; D="dddddddddddd"

# --- 1. a normal release, with a hostile install ---
echo "release A (the install misbehaves)"
export STUB_TAMPER=1
nameA="$(deliver "$A" 1 0)"
cp "$r/opt/bulig/releases/$nameA/packages/cli/bin/bulig.mjs" "$work/good-cli.mjs"
cp "$r/opt/bulig/releases/$nameA/packages/core/index.js" "$work/good-core.js"
expect_ok "the release runs" run_remote "$A" "$nameA"
relA="$r/opt/bulig/releases/$A"
tkA="$r/usr/local/lib/bulig/$A"
if [ "$(link_of "$r/opt/bulig/current")" = "$A" ] && [ "$(link_of "$r/usr/local/lib/bulig/current")" = "$A" ]; then ok "both current links point at the new release"; else bad "links: $(readlink "$r/opt/bulig/current") $(readlink "$r/usr/local/lib/bulig/current")"; fi
if [ -f "$relA/node_modules/dep/index.js" ] && [ -f "$relA/packages/cli/node_modules/x/index.js" ]; then ok "node_modules from the install are in the release"; else bad "node_modules missing"; fi
if cmp -s "$relA/packages/cli/bin/bulig.mjs" "$work/good-cli.mjs"; then ok "a tracked file the install edited is back to what was delivered"; else bad "bulig.mjs was changed by the install and kept"; fi
if [ ! -e "$relA/evil.sh" ]; then ok "a file the install added outside node_modules is not in the release"; else bad "evil.sh got into the release"; fi
sleep 3
if cmp -s "$relA/packages/core/index.js" "$work/good-core.js"; then ok "a write through a handle kept open by the install, made later, does not reach the release"; else bad "a late write reached the live release: $(cat "$relA/packages/core/index.js")"; fi
if [ ! -e "$relA/deploy" ]; then ok "the Node tree holds nothing from deploy/"; else bad "deploy/ is inside the Node release tree"; fi
if [ -x "$tkA/health.sh" ] && [ "$(mode "$tkA/health.sh")" = "755" ] && [ "$(mode "$tkA")" = "755" ]; then ok "the root tools are installed 0755 from the delivered copy"; else bad "tools modes: $(mode "$tkA/health.sh") $(mode "$tkA")"; fi
if [ -f "$r/etc/systemd/system/bulig.service" ] && grep -q "version $A" "$r/etc/systemd/system/bulig.service"; then ok "the unit files came from the root tools copy"; else bad "unit files not installed"; fi
if [ -f "$r/var/lib/bulig/.bulig/config.json" ]; then ok "the config was created on the first release"; else bad "no config"; fi
if grep -q -- "--uid=bulig" "$STUB_LOG/calls" && grep -q -- "KillMode=control-group" "$STUB_LOG/calls"; then ok "the install ran through systemd-run as bulig with KillMode=control-group"; else bad "install call: $(grep systemd-run "$STUB_LOG/calls" | head -1)"; fi
if [ -z "$(find "$r/opt/bulig/releases" "$r/usr/local/lib/bulig" -maxdepth 1 -name '.incoming-*' | head -1)" ]; then ok "no incoming folders are left behind"; else bad "left: $(find "$r/opt/bulig/releases" "$r/usr/local/lib/bulig" -maxdepth 1 -name '.incoming-*')"; fi
unset STUB_TAMPER

# --- 2. an unhealthy release rolls back ---
echo "release B (health check fails)"
nameB="$(deliver "$B" 2 1)"
expect_fail_msg "a failed health check fails the release" "FAILED" run_remote "$B" "$nameB"
if [ "$(link_of "$r/opt/bulig/current")" = "$A" ] && [ "$(link_of "$r/usr/local/lib/bulig/current")" = "$A" ]; then ok "both links are back on the previous release"; else bad "links after rollback: $(readlink "$r/opt/bulig/current") $(readlink "$r/usr/local/lib/bulig/current")"; fi
if grep -q "version $A" "$r/etc/systemd/system/bulig.service"; then ok "the unit files are back to the previous release's"; else bad "unit file after rollback: $(cat "$r/etc/systemd/system/bulig.service")"; fi

# --- 3. a unit that cannot be installed after the links moved rolls back ---
echo "release C (a unit file is missing)"
nameC="$(deliver "$C" 3 0 bulig-worker.service)"
expect_fail_msg "a failed unit install fails the release" "FAILED" run_remote "$C" "$nameC"
if [ "$(link_of "$r/opt/bulig/current")" = "$A" ] && [ "$(link_of "$r/usr/local/lib/bulig/current")" = "$A" ]; then ok "and both links are still on the previous release"; else bad "links after the failed install: $(readlink "$r/opt/bulig/current") $(readlink "$r/usr/local/lib/bulig/current")"; fi
if grep -q "version $A" "$r/etc/systemd/system/bulig.service"; then ok "and the unit files are the previous release's"; else bad "unit files after the failed install"; fi

# --- 4. the live sha is refused ---
echo "release A again"
nameA2="$(deliver "$A" 4 0)"
run_remote "$A" "$nameA2" >"$work/out" 2>&1
rc=$?
if [ "$rc" -eq 3 ] && grep -q "already the live release" "$work/out"; then ok "a sha that is already live is refused with exit 3"; else bad "rc=$rc: $(cat "$work/out")"; fi

# --- 5. bad arguments ---
echo "arguments"
expect_fail_msg "a bad incoming name is refused" "odd incoming name" bash "$deploy/release-remote.sh" "$D" 5 "../../etc"
expect_fail_msg "a bad sha is refused" "odd short sha" bash "$deploy/release-remote.sh" "xyz" 5 ".incoming-$D-1"

finish
