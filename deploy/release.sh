#!/usr/bin/env bash
# Release a git ref of Bulig to ths-prod-01. Run from the Mac, inside the bulig checkout:
#   bash deploy/release.sh [ref]          (default: HEAD)
# Steps: git archive of the ref -> rsync to a private incoming folder on the server -> (under a lock) pnpm install as bulig -> hand the
# folder to root -> rename it to /opt/bulig/releases/<sha> -> swap the "current" symlink atomically -> install the units -> restart the
# kernel and the worker -> health check -> put the previous release AND the previous unit files back if it fails.
# It never touches anything outside /opt/bulig, /etc/systemd/system/bulig*, and the two Bulig services.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

HOST="${BULIG_DEPLOY_HOST:-ths-prod-01}"
KEEP="${BULIG_KEEP_RELEASES:-5}"
ref="${1:-HEAD}"

sha="$(git rev-parse --verify --quiet "$ref^{commit}")" || { echo "release: '$ref' is not a commit in this repo" >&2; exit 1; }
short="${sha:0:12}"
echo "==> releasing $ref = $short to $HOST"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
git archive --format=tar "$sha" | tar -x -C "$stage"
[ -f "$stage/pnpm-lock.yaml" ] || { echo "release: the archive has no pnpm-lock.yaml" >&2; exit 1; }
[ -x "$stage/deploy/health.sh" ] || { echo "release: ref $ref has no deploy kit (deploy/health.sh)" >&2; exit 1; }

ssh "$HOST" "test -d /opt/bulig/releases && id bulig >/dev/null && id bulig-worker >/dev/null" || { echo "release: /opt/bulig/releases or the bulig users are missing on $HOST. Run setup-user.sh first." >&2; exit 1; }

# A folder of its own per run, so two releases of the same sha cannot write into each other. The server renames it into place under a lock.
incoming="/opt/bulig/releases/.incoming-$short-$$"
echo "==> rsync to $HOST:$incoming"
rsync -az --delete "$stage/" "$HOST:$incoming/"

echo "==> install, swap, restart, check (on $HOST)"
# The remote part is one script on stdin, so nothing needs quoting on a command line.
set +e
ssh "$HOST" bash -s -- "$short" "$KEEP" "$incoming" <<'REMOTE'
set -euo pipefail
short="$1"; keep="$2"; incoming="$3"
rel="/opt/bulig/releases/$short"
cur=/opt/bulig/current
units="bulig.service bulig-worker.service bulig-backup.service bulig-backup.timer bulig-restore-drill.service bulig-restore-drill.timer"

case "$incoming" in /opt/bulig/releases/.incoming-*) ;; *) echo "release: odd incoming path" >&2; exit 1 ;; esac
unit_backup=""
pristine="$incoming.orig"
cleanup() { rm -rf "$incoming" "$pristine"; [ -z "$unit_backup" ] || rm -rf "$unit_backup"; }
trap cleanup EXIT

# One release at a time on this host.
exec 9>/opt/bulig/.release.lock
flock -n 9 || { echo "release: another release is running on this host" >&2; exit 1; }
find /opt/bulig/releases -maxdepth 1 -name '.incoming-*' -mmin +1440 -exec rm -rf {} + 2>/dev/null || true

prev=""
if [ -L "$cur" ]; then prev="$(readlink -f "$cur")"; fi
if [ "$prev" = "$rel" ]; then
  echo "release: $short is already the live release. Nothing changed." >&2
  exit 3
fi

# 1. Install dependencies as bulig, check that bulig changed nothing but node_modules, then give the release to root so neither service can
#    rewrite its own code. Dependency build scripts (better-sqlite3 needs its build, so --ignore-scripts is not an option) run as bulig and
#    could edit any file in this folder. Some of these files later run as root (deploy/*.sh) or are copied to /etc/systemd/system, so the
#    folder is compared with a root-owned copy of what was delivered, and the release fails on any difference outside node_modules.
#    "copy" import: node_modules holds real copies, so the chown to root never reaches through a hard link into bulig's package store.
if [ -d "$rel" ]; then
  echo "release: $short is already unpacked (not live); reusing it"
else
  chown -R root:root "$incoming"
  cp -a "$incoming" "$pristine"
  chown -R bulig:bulig "$incoming"
  runuser -u bulig -- env HOME=/var/lib/bulig PATH="/usr/local/bin:/usr/bin:/bin:/var/lib/bulig/.local/bin" \
    bash -c "cd '$incoming' && pnpm install --frozen-lockfile --prod=false --config.package-import-method=copy --store-dir /var/lib/bulig/.local/share/pnpm/store"
  changed="$(rsync -rlpcni --delete --exclude=node_modules "$pristine/" "$incoming/")"
  if [ -n "$changed" ]; then
    echo "release: the install changed files outside node_modules. Refusing this release:" >&2
    echo "$changed" >&2
    exit 1
  fi
  chown -R root:root "$incoming"
  chmod -R go-w "$incoming"
  mv -T "$incoming" "$rel"
fi

# 2. Keep what is installed now, so a rollback restores the old unit files too, not just the old code.
unit_backup="$(mktemp -d /opt/bulig/.unit-backup.XXXXXX)"
for u in $units; do
  if [ -e "/etc/systemd/system/$u" ]; then cp -p "/etc/systemd/system/$u" "$unit_backup/$u"; fi
done

restore_units() {
  for u in $units; do
    if [ -e "$unit_backup/$u" ]; then cp -p "$unit_backup/$u" "/etc/systemd/system/$u"; else rm -f "/etc/systemd/system/$u"; fi
  done
}

# 3. Swap the symlink in one atomic rename, then install the units of the new release. The config is only created if absent: it is edited by hand.
ln -sfn "$rel" /opt/bulig/current.new
mv -T /opt/bulig/current.new "$cur"
echo "current -> $rel (previous: ${prev:-none})"
for u in $units; do install -m 0644 "$rel/deploy/systemd/$u" /etc/systemd/system/; done
if [ ! -e /var/lib/bulig/.bulig/config.json ]; then
  install -m 0640 -o root -g bulig "$rel"/deploy/bulig.config.vps.json /var/lib/bulig/.bulig/config.json
  echo "config: created /var/lib/bulig/.bulig/config.json from the VPS template (Telegram off, local worker off)"
fi
# 4. Reload, enable, restart, health. Any failure rolls back to the previous release and the previous unit files (if there was one).
healthy=0
if systemctl daemon-reload \
  && systemctl enable bulig.service bulig-worker.service >/dev/null 2>&1 \
  && systemctl restart bulig.service bulig-worker.service \
  && "$cur/deploy/health.sh" --wait 40; then
  healthy=1
fi
if [ "$healthy" -eq 1 ]; then
  echo "release: healthy on $short"
  # Keep the newest releases, never the live one or the previous one.
  ls -1dt /opt/bulig/releases/*/ | sed 's:/$::' | tail -n +"$((keep + 1))" | while read -r old; do
    [ "$old" = "$(readlink -f "$cur")" ] && continue
    [ "$old" = "$prev" ] && continue
    rm -rf "$old"
  done
  exit 0
fi

echo "release: reload, restart or health check FAILED on $short" >&2
journalctl -u bulig.service -u bulig-worker.service -n 40 --no-pager >&2 || true
if [ -n "$prev" ] && [ -d "$prev" ]; then
  echo "release: rolling back to $prev (code and unit files)" >&2
  ln -sfn "$prev" /opt/bulig/current.new
  mv -T /opt/bulig/current.new "$cur"
  restore_units
  systemctl daemon-reload
  systemctl restart bulig.service bulig-worker.service
  if "$cur/deploy/health.sh" --wait 40; then
    echo "release: rolled back, healthy on $(basename "$prev")" >&2
  else
    echo "release: rollback is ALSO unhealthy. Look at journalctl -u bulig.service -u bulig-worker.service." >&2
  fi
else
  echo "release: no previous release to go back to. Stopping both services so they do not crash-loop." >&2
  systemctl stop bulig-worker.service bulig.service
fi
exit 1
REMOTE
rc=$?
set -e
if [ "$rc" -eq 3 ]; then echo "release: refused, $short is already live on $HOST" >&2; exit 3; fi
[ "$rc" -eq 0 ] || { echo "release: FAILED (see above)" >&2; exit "$rc"; }
echo "==> done: $short is live on $HOST"
