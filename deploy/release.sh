#!/usr/bin/env bash
# Release a git ref of Bulig to ths-prod-01. Run from the Mac, inside the bulig checkout:
#   bash deploy/release.sh [ref]          (default: HEAD)
# Steps: git archive of the ref -> rsync to /opt/bulig/releases/<sha> -> pnpm install as bulig -> hand the folder back to root ->
# swap the "current" symlink atomically -> install units -> restart bulig -> health check -> roll back to the previous release if it fails.
# It never touches anything outside /opt/bulig, /etc/systemd/system/bulig*, and the bulig service.
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

echo "==> rsync to $HOST:/opt/bulig/releases/$short"
ssh "$HOST" "test -d /opt/bulig/releases && id bulig >/dev/null" || { echo "release: /opt/bulig/releases or the bulig user is missing on $HOST. Run setup-user.sh first." >&2; exit 1; }
rsync -az --delete "$stage/" "$HOST:/opt/bulig/releases/$short/"

echo "==> install, swap, restart, check (on $HOST)"
# The remote part is one script on stdin, so nothing needs quoting on a command line.
set +e
ssh "$HOST" bash -s -- "$short" "$KEEP" <<'REMOTE'
set -euo pipefail
short="$1"; keep="$2"
rel="/opt/bulig/releases/$short"
cur=/opt/bulig/current

# 1. Install dependencies as bulig, then give the release back to root so the service cannot rewrite its own code.
chown -R bulig:bulig "$rel"
runuser -u bulig -- env HOME=/var/lib/bulig PATH="/usr/local/bin:/usr/bin:/bin:/var/lib/bulig/.local/bin" \
  bash -c "cd '$rel' && pnpm install --frozen-lockfile --prod=false"
chown -R root:root "$rel"
chmod -R go-w "$rel"

# 2. Remember what is live, then swap the symlink in one atomic rename.
prev=""
if [ -L "$cur" ]; then prev="$(readlink -f "$cur")"; fi
ln -sfn "$rel" /opt/bulig/current.new
mv -T /opt/bulig/current.new "$cur"
echo "current -> $rel (previous: ${prev:-none})"

# 3. The unit files and the config template come with the release. The config itself is only created if absent: it is edited by hand.
install -m 0644 "$rel"/deploy/systemd/bulig.service "$rel"/deploy/systemd/bulig-backup.service "$rel"/deploy/systemd/bulig-backup.timer \
  "$rel"/deploy/systemd/bulig-restore-drill.service "$rel"/deploy/systemd/bulig-restore-drill.timer /etc/systemd/system/
if [ ! -e /var/lib/bulig/.bulig/config.json ]; then
  install -m 0640 -o root -g bulig "$rel"/deploy/bulig.config.vps.json /var/lib/bulig/.bulig/config.json
  echo "config: created /var/lib/bulig/.bulig/config.json from the VPS template (Telegram off)"
fi
systemctl daemon-reload
systemctl enable bulig.service >/dev/null 2>&1
systemctl restart bulig.service

# 4. Health. Failure rolls back to the previous release (if there was one).
if "$cur/deploy/health.sh" --wait 40; then
  echo "release: healthy on $short"
  # Keep the newest releases, never the live one or the previous one.
  ls -1dt /opt/bulig/releases/*/ | sed 's:/$::' | tail -n +"$((keep + 1))" | while read -r old; do
    [ "$old" = "$(readlink -f "$cur")" ] && continue
    [ "$old" = "$prev" ] && continue
    rm -rf "$old"
  done
  exit 0
fi

echo "release: health check FAILED on $short" >&2
journalctl -u bulig.service -n 30 --no-pager >&2 || true
if [ -n "$prev" ] && [ -d "$prev" ]; then
  echo "release: rolling back to $prev" >&2
  ln -sfn "$prev" /opt/bulig/current.new
  mv -T /opt/bulig/current.new "$cur"
  systemctl daemon-reload
  systemctl restart bulig.service
  if "$cur/deploy/health.sh" --wait 40; then
    echo "release: rolled back, healthy on $(basename "$prev")" >&2
  else
    echo "release: rollback is ALSO unhealthy. Look at journalctl -u bulig.service." >&2
  fi
else
  echo "release: no previous release to go back to. Stopping the service so it does not crash-loop." >&2
  systemctl stop bulig.service
fi
exit 1
REMOTE
rc=$?
set -e
[ "$rc" -eq 0 ] || { echo "release: FAILED (see above)" >&2; exit "$rc"; }
echo "==> done: $short is live on $HOST"
