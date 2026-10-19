#!/usr/bin/env bash
# Put one secret on the server from stdin, so it never appears in a command line, shell history or ps. Prints the length, never the value.
#   credential (one root-only file per secret, loaded by systemd LoadCredential=):
#     set-secret.sh --credential <pg-url|gh-token|claude-token|worker-tokens> < value
#     security find-generic-password -s <item> -w | ssh ths-prod-01 '/opt/bulig/current/deploy/set-secret.sh --credential gh-token'
#   one KEY=value line in the backup keys file (R2 keys, used only by the backup units):
#     set-secret.sh NAME [env-file] < value
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
need_root

if [ "${1:-}" = "--credential" ]; then
  cred_write "${2:?--credential needs a name}"
  exit 0
fi
name="${1:-}"
file="${2:-$BULIG_ENV_FILE}"
[[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "usage: set-secret.sh NAME [env-file], with the value on stdin"
value="$(cat)"
value="${value%$'\n'}"
[ -n "$value" ] || die "nothing on stdin"
case "$value" in *$'\n'*) die "the value has more than one line" ;; esac
env_set "$name" "$value" "$file"
chown root:root "$file"
chmod 600 "$file"
echo "set $name in $file (${#value} characters)"
