#!/usr/bin/env bash
# Dump the bulig database, gzip it, checksum it, send both to R2 under bulig/postgres/, and check the object is there.
# Runs from bulig-backup.service (root; credentials pg-url and backup-env come from LoadCredential=). Exit non-zero on any failure.
# The database is read over 127.0.0.1:5436 with the explicit-host URL in the pg-url credential.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
# shellcheck source=lib/r2.sh
. "$here/lib/r2.sh"

spool=/var/backups/bulig
pg_url="$(cat "$(cred_path pg-url)")" || die "cannot read the pg-url credential"
case "$pg_url" in *"@127.0.0.1:$BULIG_PG_PORT/"*) ;; *) die "the pg-url credential does not point at 127.0.0.1:$BULIG_PG_PORT" ;; esac
r2_require_env

install -d -m 0700 "$spool"
started=$SECONDS
stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
name="bulig-postgres-$stamp.sql.gz"
archive="$spool/$name"
trap 'rm -f "$archive.partial"' EXIT

# pipefail: a failed pg_dump fails the whole line instead of leaving a valid-looking empty gzip.
"$(pg_bin pg_dump)" --format=plain --no-owner --no-privileges "$pg_url" | gzip -9 >"$archive.partial"
gzip -t "$archive.partial"
bytes="$(stat -c %s "$archive.partial")"
[ "$bytes" -gt 1024 ] || die "the dump is only $bytes bytes: refusing to upload something that looks empty"
mv "$archive.partial" "$archive"
(cd "$spool" && sha256sum "$name" >"$name.sha256")

r2_put "$archive" "$R2_PREFIX/$name"
r2_put "$archive.sha256" "$R2_PREFIX/$name.sha256"

# The head-object check: the object is in R2 and is the size we sent.
remote="$(r2_size "$R2_PREFIX/$name")"
[ "$remote" = "$bytes" ] || die "R2 holds $remote bytes for $name, we sent $bytes"
remote_sum="$(r2_size "$R2_PREFIX/$name.sha256")"
[ -n "$remote_sum" ] || die "the checksum object is missing in R2"

# Keep two weeks of local copies. R2 keeps what its own lifecycle rule keeps.
find "$spool" -maxdepth 1 -type f -name 'bulig-postgres-*' -mtime +14 -delete
echo "bulig-backup: ok key=$R2_PREFIX/$name bytes=$bytes seconds=$((SECONDS - started))"
