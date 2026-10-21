#!/usr/bin/env bash
# Put one secret on the server from stdin, so it never appears in a command line, shell history or ps. Prints the length, never the value.
# It writes only to fixed files under /etc/bulig (root's) and refuses anything else: there is no path argument.
#   one secret, one root-only file (loaded by systemd LoadCredential= into the unit that needs it):
#     set-secret.sh --credential <pg-url|gh-token|worker-tokens|claude-token|worker-token|github-read-token|drill-pw> < value
#     security find-generic-password -s <item> -w | ssh ths-prod-01 '/usr/local/lib/bulig/current/set-secret.sh --credential gh-token'
#     (github-read-token is the worker's read-only token for its own clone; Keychain item bulig-worker-read-token on the Mac)
#   one worker's token (a line "id=token" in worker-tokens, which the kernel reads; for the id "vps" also the worker's own worker-token):
#     openssl rand -hex 32 | ssh ths-prod-01 '/usr/local/lib/bulig/current/set-secret.sh --worker-token vps'
#   the worker's repositories (not secret; /etc/bulig/worker.env, read by bulig-worker.service; at least one is needed):
#     echo 'BULIG_WORKER_REPOS=--repo /var/lib/bulig/repos/sandbox=/var/lib/bulig-worker/work/sandbox' | ssh ths-prod-01 '/usr/local/lib/bulig/current/set-secret.sh --worker-env'
#   the machine-specific fence probes (/etc/bulig/fence-extra-probes.txt, root 0600; filled in from fence/extra-probes.template, see the RUNBOOK):
#     ssh ths-prod-01 '/usr/local/lib/bulig/current/set-secret.sh --fence-extra-probes' < filled-in-file
#   one R2 setting in /etc/bulig/backup.env (used only by the backup units):
#     set-secret.sh --backup-key <R2_ENDPOINT|R2_BUCKET|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|...> < value
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"
need_root

usage="usage: set-secret.sh --credential <name> | --worker-token <id> | --backup-key <NAME> | --worker-env | --fence-extra-probes, with the value on stdin. No other arguments."
if [ "$#" -eq 1 ] && [ "$1" = "--worker-env" ]; then
  worker_env_write
  exit 0
fi
if [ "$#" -eq 1 ] && [ "$1" = "--fence-extra-probes" ]; then
  fence_extra_write
  exit 0
fi
[ "$#" -eq 2 ] || die "$usage"
case "$1" in
  --credential) cred_write "$2" ;;
  --worker-token) worker_token_write "$2" ;;
  --backup-key) backup_key_write "$2" ;;
  *) die "$usage" ;;
esac
