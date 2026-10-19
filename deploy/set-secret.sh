#!/usr/bin/env bash
# Put one secret on the server from stdin, so it never appears in a command line, shell history or ps. Prints the length, never the value.
# It writes only to fixed files under /etc/bulig and refuses anything else: there is no path argument.
#   one secret, one root-only file (loaded by systemd LoadCredential= into the unit that needs it):
#     set-secret.sh --credential <pg-url|gh-token|worker-tokens|claude-token|worker-token|drill-pw> < value
#     security find-generic-password -s <item> -w | ssh ths-prod-01 '/opt/bulig/current/deploy/set-secret.sh --credential gh-token'
#   one R2 setting in /etc/bulig/backup.env (used only by the backup units):
#     set-secret.sh --backup-key <R2_ENDPOINT|R2_BUCKET|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|...> < value
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
need_root

[ "$#" -eq 2 ] || die "usage: set-secret.sh --credential <name> | --backup-key <NAME>, with the value on stdin. No other arguments."
case "$1" in
  --credential) cred_write "$2" ;;
  --backup-key) backup_key_write "$2" ;;
  *) die "usage: set-secret.sh --credential <name> | --backup-key <NAME>, with the value on stdin" ;;
esac
