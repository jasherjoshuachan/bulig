#!/usr/bin/env bash
# Dump the bulig database (custom format, already compressed), send it to R2 under bulig/postgres/, check the object is there, and
# record its sha256 in the root-owned local index. The restore drill trusts that index, never R2.
# Runs from bulig-backup.service (root; credentials pg-url and backup-env come from LoadCredential=). Exit non-zero on any failure.
# The database is read as the bulig role over 127.0.0.1:5436. The password goes in through a PGPASSFILE in a 0700 folder of /var/lib/bulig-checks (root's),
# never on a command line (any user on this host can read other processes' arguments).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
# shellcheck source=lib/r2.sh
. "$here/lib/r2.sh"
need_root
r2_require_env
umask 077

spool="$BULIG_BACKUP_DIR"
need_dir "$spool"
started=$SECONDS
stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
name="bulig-postgres-$stamp.dump"
archive="$spool/$name"
work="$(private_tmpdir)"
trap 'rm -rf "$work"; rm -f "$archive.partial"' EXIT

PGPASSFILE="$(pg_passfile "$(cred_path pg-url)" "$work")"
export PGPASSFILE
export PGCONNECT_TIMEOUT=15

# -w: never ask for a password. A password file that does not match 127.0.0.1:5436 / bulig fails here, loudly.
"$(pg_bin pg_dump)" -Fc -Z 6 --no-owner --no-privileges -w -h 127.0.0.1 -p "$BULIG_PG_PORT" -U bulig -d bulig -f "$archive.partial"
"$(pg_bin pg_restore)" --list "$archive.partial" >/dev/null || die "the dump is not a readable archive"
bytes="$(wc -c <"$archive.partial" | tr -d ' ')"
[ "$bytes" -gt 1024 ] || die "the dump is only $bytes bytes: refusing to upload something that looks empty"
mv "$archive.partial" "$archive"
sum="$(sha256sum "$archive" | cut -d' ' -f1)"
printf '%s  %s\n' "$sum" "$name" >"$archive.sha256"

r2_put "$archive" "$R2_PREFIX/$name"
r2_put "$archive.sha256" "$R2_PREFIX/$name.sha256"

# The head-object check: the object is in R2 and is the size we sent.
remote="$(r2_size "$R2_PREFIX/$name")"
[ "$remote" = "$bytes" ] || die "R2 holds $remote bytes for $name, we sent $bytes"

# Only now is the backup real: write it to the local index (root-owned, append-only by this script).
printf '%s  %s\n' "$sum" "$R2_PREFIX/$name" >>"$BULIG_BACKUP_INDEX"

# Keep two weeks of local copies. The index is kept.
find "$spool" -maxdepth 1 -type f -name 'bulig-postgres-*' -mtime +14 -delete
echo "bulig-backup: ok key=$R2_PREFIX/$name bytes=$bytes sha256=$sum seconds=$((SECONDS - started))"
