#!/usr/bin/env bash
# Prove the newest R2 backup restores. Download it, check its checksum, restore it into a scratch database on the SAME cluster
# (16 bulig, port 5436), compare tables and row counts with the live database, log the time, drop the scratch database.
# Runs from bulig-restore-drill.service (root; the backup-env credential comes from LoadCredential=). Exit non-zero if any check fails.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
# shellcheck source=lib/r2.sh
. "$here/lib/r2.sh"
need_root
r2_require_env

work=/var/backups/bulig/drill
install -d -m 0700 "$work"
scratch="bulig_drill_$(date -u +%Y%m%d%H%M%S)"
started=$SECONDS
cleanup() {
  psql_admin -c "DROP DATABASE IF EXISTS \"$scratch\" WITH (FORCE)" >/dev/null 2>&1 || echo "bulig-restore-drill: WARNING could not drop $scratch" >&2
  rm -rf "$work"
}
trap cleanup EXIT

# Leftovers from a drill that was killed. Only databases with this drill's own name prefix.
for old in $(psql_admin -tA -c "SELECT datname FROM pg_database WHERE datname LIKE 'bulig\_drill\_%'"); do
  psql_admin -c "DROP DATABASE IF EXISTS \"$old\" WITH (FORCE)" >/dev/null
done

key="$(r2_newest_dump)"
case "$key" in "$R2_PREFIX/"*.sql.gz) ;; *) die "no dump found under $R2_PREFIX/ in R2 (got '$key')" ;; esac
base="$(basename "$key")"
mkdir -p "$work"
r2_get "$key" "$work/$base"
r2_get "$key.sha256" "$work/$base.sha256"
(cd "$work" && sha256sum -c "$base.sha256" >/dev/null) || die "checksum mismatch for $key"
gzip -t "$work/$base"

restore_started=$SECONDS
psql_admin -c "CREATE DATABASE \"$scratch\"" >/dev/null
# The dump was taken with --no-owner, so the scratch objects belong to postgres. That is fine for a count check.
gzip -dc "$work/$base" | psql_admin -d "$scratch" -f - >/dev/null
restore_seconds=$((SECONDS - restore_started))

# Same tables, and rows where the live database has rows. Counts differ a little by design: the live database moved on since the dump.
tables_sql="SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"
live_tables="$(psql_admin -d bulig -tA -c "$tables_sql")"
scratch_tables="$(psql_admin -d "$scratch" -tA -c "$tables_sql")"
[ -n "$scratch_tables" ] || die "the restored database has no tables"
[ "$live_tables" = "$scratch_tables" ] || die "table lists differ. live: $(echo "$live_tables" | tr '\n' ' ') restored: $(echo "$scratch_tables" | tr '\n' ' ')"

summary=""
problems=0
for t in $scratch_tables; do
  live_n="$(psql_admin -d bulig -tA -c "SELECT count(*) FROM \"$t\"")"
  scratch_n="$(psql_admin -d "$scratch" -tA -c "SELECT count(*) FROM \"$t\"")"
  summary="$summary $t=$scratch_n/$live_n"
  if [ "$live_n" -gt 0 ] && [ "$scratch_n" -eq 0 ]; then
    echo "bulig-restore-drill: table $t has $live_n rows live and 0 restored" >&2
    problems=1
  fi
done
[ "$problems" -eq 0 ] || die "restored database is missing rows (restored/live:$summary)"

echo "bulig-restore-drill: ok dump=$key restore_seconds=$restore_seconds total_seconds=$((SECONDS - started)) rows(restored/live):$summary"
