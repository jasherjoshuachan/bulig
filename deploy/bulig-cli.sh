#!/usr/bin/env bash
# Run one bulig CLI command on the server as the bulig user, with the same credentials the service has.
#   usage (as root): deploy/bulig-cli.sh run --repo <path> --title <text>
# Only one writer may hold the database: stop bulig.service first for commands that write (run, resume, migrate), start it after.
# Read-only commands (status, history) can run while the service is up.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
need_root

# Do what systemd's LoadCredential= does for the service: a private folder with one file per secret, readable by bulig only, named in
# $CREDENTIALS_DIRECTORY. No secret goes into the environment, so the Claude sessions a job starts cannot inherit one.
creds="$(mktemp -d /run/bulig-cli.XXXXXX)"
trap 'rm -rf "$creds"' EXIT
chmod 700 "$creds"
for name in $BULIG_CREDENTIALS; do
  if [ -r "$BULIG_CRED_DIR/$name" ]; then install -m 0400 -o bulig -g bulig "$BULIG_CRED_DIR/$name" "$creds/$name"; fi
done
chown bulig:bulig "$creds"

cd "$(dirname "$here")"
# Not exec: the trap must remove the credentials folder when the command ends.
setpriv --reuid=bulig --regid=bulig --init-groups \
  env "HOME=$BULIG_HOME" "PATH=/usr/local/bin:/usr/bin:/bin:$BULIG_HOME/.local/bin" "CREDENTIALS_DIRECTORY=$creds" \
  node packages/cli/bin/bulig.mjs "$@"
