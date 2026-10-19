#!/usr/bin/env bash
# Tests for backup-postgres.sh and restore-drill.sh with stubbed pg tools and a stubbed aws. They prove:
#   - the drill restores only an object whose sha256 is in the local index (a swapped object in R2 is refused, pg_restore never runs);
#   - the drill refuses a stale backup;
#   - no secret (the database password, the drill password, the R2 key) ever appears in the arguments of aws, docker, pg_dump, pg_restore or psql;
#   - the R2 key reaches docker on stdin, not in its arguments or environment.
# shellcheck disable=SC1091,SC2030,SC2031,SC2154
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

SECRET_PG="S3cr3tPw"
SECRET_DRILL="DrillPw9"
SECRET_R2="FakeR2SecretKey"
r="$work/r"
log="$work/log"
r2="$work/r2"
stubs="$work/stubs"
mkdir -p "$r/etc/bulig" "$r/var/backups/bulig" "$r/var/lib/bulig-checks" "$log" "$r2" "$stubs"
chmod 700 "$r/var/lib/bulig-checks"
printf 'postgres://bulig:%s@%%2Fvar%%2Frun%%2Fpostgresql:5436/bulig' "$SECRET_PG" >"$r/etc/bulig/pg-url"
printf '%s' "$SECRET_DRILL" >"$r/etc/bulig/drill-pw"
printf 'R2_ENDPOINT=https://example.invalid\nR2_BUCKET=b\nAWS_ACCESS_KEY_ID=AKIAFAKE\nAWS_SECRET_ACCESS_KEY=%s\nAWS_DEFAULT_REGION=auto\n' "$SECRET_R2" >"$r/etc/bulig/backup.env"

# --- stubs: each records its arguments (and PGPASSFILE content) and does a tiny bit of the real job ---
cat >"$stubs/aws" <<'STUB'
#!/usr/bin/env bash
echo "aws $*" >>"$STUB_LOG/argv"
shift 2 # --endpoint-url X
case "$1 $2" in
  "s3 cp")
    src="$3"; dst="$4"
    case "$src" in
      s3://*) # download
        key="${src#s3://*/}"
        if [ -n "${STUB_TAMPER:-}" ]; then echo "this is not the dump you made" >"$dst"; else cp "$STUB_R2/$key" "$dst"; fi ;;
      *) key="${dst#s3://*/}"; mkdir -p "$(dirname "$STUB_R2/$key")"; cp "$src" "$STUB_R2/$key" ;;
    esac ;;
  "s3api head-object") key=""; while [ "$#" -gt 0 ]; do [ "$1" = "--key" ] && key="$2"; shift; done; wc -c <"$STUB_R2/$key" | tr -d ' ' ;;
esac
STUB
cat >"$stubs/pg_dump" <<'STUB'
#!/usr/bin/env bash
echo "pg_dump $*" >>"$STUB_LOG/argv"
echo "pg_dump PGPASSFILE=$(cat "$PGPASSFILE")" >>"$STUB_LOG/passfile"
out=""; while [ "$#" -gt 0 ]; do [ "$1" = "-f" ] && out="$2"; shift; done
head -c 3000 /dev/zero | tr '\0' 'x' >"$out"
STUB
cat >"$stubs/pg_restore" <<'STUB'
#!/usr/bin/env bash
echo "pg_restore $*" >>"$STUB_LOG/argv"
case " $* " in *" --list "*) exit 0 ;; esac
echo "$*" >>"$STUB_LOG/restore.called"
STUB
cat >"$stubs/psql" <<'STUB'
#!/usr/bin/env bash
echo "psql $*" >>"$STUB_LOG/argv"
echo "psql PGPASSFILE=$(cat "$PGPASSFILE")" >>"$STUB_LOG/passfile"
sql=""; while [ "$#" -gt 0 ]; do [ "$1" = "-c" ] && sql="$2"; shift; done
case "$sql" in
  *"FROM pg_database"*) ;;
  *cntrl*) echo 0 ;;
  *information_schema.tables*) printf 'public.jobs\npublic."a b"\npublic."x*"\n' ;;
  *"SELECT count(*)"*) echo 3 ;;
esac
exit 0
STUB
cat >"$stubs/sha256sum" <<'STUB'
#!/usr/bin/env bash
exec shasum -a 256 "$@"
STUB
chmod +x "$stubs"/*
export STUB_LOG="$log" STUB_R2="$r2" BULIG_DEPLOY_TEST_ROOT="$r"
export PATH="$stubs:/usr/bin:/bin:/usr/sbin:/sbin"

# --- epoch_from_utc ---
echo "epoch_from_utc"
for case_ in "2026 10 19 03 15 00 1792379700" "2024 02 29 23 59 59 1709251199" "1970 01 01 00 00 00 0"; do
  # shellcheck disable=SC2086
  set -- $case_
  got="$(. "$deploy/lib/common.sh"; epoch_from_utc "$1" "$2" "$3" "$4" "$5" "$6")"
  if [ "$got" = "$7" ]; then ok "epoch of $1-$2-$3 $4:$5:$6 is $7"; else bad "epoch of $1-$2-$3 is $got, expected $7"; fi
done

# --- backup ---
echo "backup-postgres.sh"
expect_ok "a backup runs" bash "$deploy/backup-postgres.sh"
idx="$r/var/backups/bulig/index"
if [ "$(wc -l <"$idx" | tr -d ' ')" = "1" ]; then ok "it recorded one line in the local index"; else bad "index: $(cat "$idx" 2>/dev/null)"; fi
key="$(cut -d' ' -f3 "$idx")"
sum="$(cut -d' ' -f1 "$idx")"
if [ -f "$r2/$key" ] && [ "$(shasum -a 256 <"$r2/$key" | cut -d' ' -f1)" = "$sum" ]; then ok "the index sha256 is the sha256 of the object in R2"; else bad "index and R2 object disagree"; fi
if grep -q "localhost:5436:bulig:bulig:$SECRET_PG" "$log/passfile"; then ok "pg_dump got its password through a PGPASSFILE"; else bad "no passfile line seen by pg_dump"; fi

# --- drill ---
echo "restore-drill.sh"
rm -f "$log/restore.called"
expect_ok "the drill restores the newest indexed dump" bash "$deploy/restore-drill.sh"
if grep -q "bulig-restore-drill: ok" "$work/out"; then ok "and says ok"; else bad "no ok line: $(cat "$work/out")"; fi
if [ -f "$log/restore.called" ] && grep -q -- "--role=bulig_drill" "$log/restore.called" && grep -q -- "-U bulig_drill" "$log/restore.called"; then ok "pg_restore ran as bulig_drill with --role"; else bad "pg_restore call: $(cat "$log/restore.called" 2>/dev/null)"; fi

rm -f "$log/restore.called"
export STUB_TAMPER=1
expect_fail_msg "a swapped object in R2 is refused" "not in the local index" bash "$deploy/restore-drill.sh"
if [ ! -e "$log/restore.called" ]; then ok "and pg_restore never ran"; else bad "pg_restore ran on a tampered object"; fi
unset STUB_TAMPER

# a stale newest entry
cp "$idx" "$work/index.good"
old="bulig/postgres/bulig-postgres-2026-01-01T03-15-00Z.dump"
cp "$r2/$key" "$r2/$old"
printf '%s  %s\n' "$sum" "$old" >"$idx"
expect_fail_msg "a backup older than 48 hours is refused" "hours old" bash "$deploy/restore-drill.sh"
cp "$work/index.good" "$idx"
cp "$idx" "$work/index.keep" && : >"$idx"
expect_fail_msg "an empty index is refused" "no backup recorded" bash "$deploy/restore-drill.sh"
cp "$work/index.keep" "$idx"

# the tables are compared and counted by their quoted names, one per line
if grep -qF 'FROM public."a b"' "$log/argv"; then ok "a table whose name has a space is counted whole, by its quoted name (no word splitting)"; else bad "count queries: $(grep 'count(' "$log/argv" | head -4)"; fi
if grep -qF 'FROM public."x*"' "$log/argv" && grep -qF 'FROM public.jobs' "$log/argv"; then ok "and so are a name with a glob character and a plain one"; else bad "count queries: $(grep 'count(' "$log/argv" | head -4)"; fi
if grep -qF 'FROM public."a ' "$log/argv" && ! grep -qF 'FROM public."a b"' "$log/argv"; then bad "the name was split"; else ok "no query was made for half a name"; fi
if grep -q "format('%I.%I', table_schema, table_name)" "$log/argv" && grep -q "format('%I', d.datname)" "$log/argv"; then ok "table and database names come back quoted by Postgres (format %I)"; else bad "names are not quoted by the server"; fi
if grep -q "table_name ~ '\[\[:cntrl:\]\]'" "$log/argv"; then ok "a table name with a control character is looked for (and refused)"; else bad "no control-character check"; fi

# --- no secret on any command line ---
echo "arguments"
for secret in "$SECRET_PG" "$SECRET_DRILL" "$SECRET_R2" "postgres://"; do
  if grep -qF -- "$secret" "$log/argv"; then bad "'$secret' appears in the arguments of a tool: $(grep -F -- "$secret" "$log/argv" | head -2)"; else ok "'$secret' is not in any tool's arguments"; fi
done
if grep -q "^pg_dump .*-h /var/run/postgresql -p 5436 -U bulig" "$log/argv" && grep -q "^psql .*-h /var/run/postgresql -p 5436 -U bulig_drill" "$log/argv"; then ok "the tools were called with an explicit host, port and user"; else bad "tool calls: $(head -5 "$log/argv")"; fi
if grep -q "^psql PGPASSFILE=.*" "$log/passfile" && grep -q "localhost:5436:\*:bulig_drill:$SECRET_DRILL" "$log/passfile"; then ok "the drill role's password reached psql through the passfile, for host localhost (a unix socket)"; else bad "no drill passfile line"; fi
if [ -z "$(find "$r/var/lib/bulig-checks" -mindepth 1 | head -1)" ]; then ok "no passfile or download is left behind"; else bad "left behind: $(find "$r/var/lib/bulig-checks")"; fi

# --- docker: the R2 key goes in on stdin ---
echo "docker"
dstubs="$work/dstubs"
mkdir -p "$dstubs"
cat >"$dstubs/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB_LOG/docker.argv"
{ read -r l1; read -r l2; } 
echo "$l1" >"$STUB_LOG/docker.line1"
echo "$l2" >"$STUB_LOG/docker.line2"
cat >"$STUB_LOG/docker.data"
STUB
chmod +x "$dstubs/docker"
(
  export PATH="$dstubs:/usr/bin:/bin"
  export R2_ENDPOINT=https://example.invalid R2_BUCKET=b AWS_ACCESS_KEY_ID=AKIAFAKE AWS_SECRET_ACCESS_KEY="$SECRET_R2"
  . "$deploy/lib/common.sh"
  . "$deploy/lib/r2.sh"
  echo "file contents" >"$work/up"
  r2_put "$work/up" "bulig/postgres/x.dump"
)
if grep -qF -- "$SECRET_R2" "$log/docker.argv"; then bad "the R2 secret is in docker's arguments"; else ok "the R2 secret is not in docker's arguments"; fi
if grep -qF -- "AKIAFAKE" "$log/docker.argv"; then bad "the R2 key id is in docker's arguments"; else ok "the R2 key id is not in docker's arguments"; fi
if grep -qE -- "-e AWS_(ACCESS|SECRET)|--env-file" "$log/docker.argv"; then bad "docker was given the key as an environment variable"; else ok "docker is given no key through -e or --env-file"; fi
if [ "$(cat "$log/docker.line1")" = "AKIAFAKE" ] && [ "$(cat "$log/docker.line2")" = "$SECRET_R2" ]; then ok "stdin carries the key id and the secret as its first two lines"; else bad "stdin lines: $(cat "$log/docker.line1") / $(cat "$log/docker.line2")"; fi
if [ "$(cat "$log/docker.data")" = "file contents" ]; then ok "the data follows on the same stream"; else bad "data: $(cat "$log/docker.data")"; fi
if grep -q -- "--entrypoint sh" "$log/docker.argv" && grep -q "amazon/aws-cli@sha256:[0-9a-f]\{64\}" "$log/docker.argv" && ! grep -qE -- " -v |--volume" "$log/docker.argv"; then ok "docker runs a pinned image, with no host mount"; else bad "docker args: $(cat "$log/docker.argv")"; fi

finish
