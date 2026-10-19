#!/usr/bin/env bash
# Prove the newest backup restores. Take the newest entry of the local index, download that object from R2, check its sha256 against
# the index, restore it into a scratch database with pg_restore as a role that owns nothing else (bulig_drill, not a superuser),
# compare tables and row counts with the live database, log the time, drop the scratch database.
# Safe even if the R2 key is shared or stolen: an object that is not in the local index is never restored, and nothing here runs
# SQL from the dump through psql or as a superuser (pg_restore applies catalog entries only, and there are no shell escapes).
# Runs from bulig-restore-drill.service (root; credentials backup-env, pg-url and drill-pw come from LoadCredential=).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
# shellcheck source=lib/r2.sh
. "$here/lib/r2.sh"
need_root
r2_require_env
umask 077

[ -s "$BULIG_BACKUP_INDEX" ] || die "no backup recorded in $BULIG_BACKUP_INDEX yet. Run bulig-backup.service first."
sum="$(tail -n1 "$BULIG_BACKUP_INDEX" | cut -d' ' -f1)"
key="$(tail -n1 "$BULIG_BACKUP_INDEX" | cut -d' ' -f3)"
case "$key" in "$R2_PREFIX/bulig-postgres-"*.dump) ;; *) die "the newest index entry is not a bulig dump key: '$key'" ;; esac
[[ "$sum" =~ ^[0-9a-f]{64}$ ]] || die "the newest index entry has no sha256"

work="$(mktemp -d)"
scratch="bulig_drill_$(date -u +%Y%m%d%H%M%S)"
started=$SECONDS

# One passfile, two logins: bulig (read the live counts) and bulig_drill (own the scratch database). Both only on 127.0.0.1:5436.
PGPASSFILE="$(pg_passfile "$(cred_path pg-url)" "$work")"
export PGPASSFILE
drill_pw="$(cat "$(cred_path drill-pw)")"
[ -n "$drill_pw" ] || die "the drill-pw credential is empty. Run setup-cluster.sh."
printf '127.0.0.1:%s:*:bulig_drill:%s\n' "$BULIG_PG_PORT" "$(pgpass_escape "$drill_pw")" >>"$PGPASSFILE"
export PGCONNECT_TIMEOUT=15

pg_args=(-w -h 127.0.0.1 -p "$BULIG_PG_PORT")
psql_drill() { "$(pg_bin psql)" -X -q "${pg_args[@]}" -U bulig_drill -v ON_ERROR_STOP=1 "$@"; }
psql_live() { "$(pg_bin psql)" -X -q "${pg_args[@]}" -U bulig -d bulig -v ON_ERROR_STOP=1 -tA "$@"; }

cleanup() {
  psql_drill -d postgres -c "DROP DATABASE IF EXISTS \"$scratch\" WITH (FORCE)" >/dev/null 2>&1 || echo "bulig-restore-drill: WARNING could not drop $scratch" >&2
  rm -rf "$work"
}
trap cleanup EXIT

# Leftovers from a drill that was killed: only databases this role owns, with this drill's name prefix.
for old in $(psql_drill -d postgres -tA -c "SELECT d.datname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE r.rolname = 'bulig_drill' AND d.datname LIKE 'bulig\_drill\_%'"); do
  psql_drill -d postgres -c "DROP DATABASE IF EXISTS \"$old\" WITH (FORCE)" >/dev/null
done

dump="$work/dump"
r2_get "$key" "$dump"
actual="$(sha256sum "$dump" | cut -d' ' -f1)"
grep -qxF "$actual  $key" "$BULIG_BACKUP_INDEX" || die "the object downloaded for $key has sha256 $actual, which is not in the local index. Refusing to restore it."
[ "$actual" = "$sum" ] || die "the object for $key does not match the sha256 recorded for it"

restore_started=$SECONDS
psql_drill -d postgres -c "CREATE DATABASE \"$scratch\"" >/dev/null
# --no-owner --role: every restored object belongs to bulig_drill. No superuser, no psql reading the dump.
"$(pg_bin pg_restore)" --no-owner --no-privileges --exit-on-error --role=bulig_drill "${pg_args[@]}" -U bulig_drill -d "$scratch" "$dump"
restore_seconds=$((SECONDS - restore_started))

# Same tables, and rows where the live database has rows. Counts differ a little by design: the live database moved on since the dump.
tables_sql="SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"
live_tables="$(psql_live -c "$tables_sql")"
scratch_tables="$(psql_drill -d "$scratch" -tA -c "$tables_sql")"
[ -n "$scratch_tables" ] || die "the restored database has no tables"
[ "$live_tables" = "$scratch_tables" ] || die "table lists differ. live: $(echo "$live_tables" | tr '\n' ' ') restored: $(echo "$scratch_tables" | tr '\n' ' ')"

summary=""
problems=0
for t in $scratch_tables; do
  live_n="$(psql_live -c "SELECT count(*) FROM \"$t\"")"
  scratch_n="$(psql_drill -d "$scratch" -tA -c "SELECT count(*) FROM \"$t\"")"
  summary="$summary $t=$scratch_n/$live_n"
  if [ "$live_n" -gt 0 ] && [ "$scratch_n" -eq 0 ]; then
    echo "bulig-restore-drill: table $t has $live_n rows live and 0 restored" >&2
    problems=1
  fi
done
[ "$problems" -eq 0 ] || die "restored database is missing rows (restored/live:$summary)"

echo "bulig-restore-drill: ok dump=$key sha256=$actual restore_seconds=$restore_seconds total_seconds=$((SECONDS - started)) rows(restored/live):$summary"
