# shellcheck shell=bash disable=SC2034
# R2 access for the backup and the restore drill. Source it after common.sh; do not run it.
# Credentials come from the environment (the unit loads /etc/bulig/backup.env). Uses the aws CLI when it is installed,
# otherwise the same pinned aws-cli image the commitments backup uses.

R2_PREFIX="bulig/postgres"
# Pinned by digest: the tag 2.27.49 as it was on ths-prod-01 on 19 Oct 2026. A tag can be moved; a digest cannot.
AWSCLI_IMAGE="${AWSCLI_IMAGE:-amazon/aws-cli@sha256:1b7003e3ecb737b7533d8e16a547b4bc36e912508c3532ae51003aad8d0cd41d}"

# load_backup_env: export the R2 settings. In a unit they come from the credential "backup-env" (LoadCredential=), by hand from
# /etc/bulig/backup.env. Read line by line, never sourced, so a value is never run as shell.
load_backup_env() {
  local f line
  f="$BULIG_BACKUP_ENV_FILE"
  if [ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -r "$CREDENTIALS_DIRECTORY/backup-env" ]; then f="$CREDENTIALS_DIRECTORY/backup-env"; fi
  [ -r "$f" ] || die "no R2 settings at $f. Fill it (names are in deploy/backup.env.example)."
  while IFS= read -r line; do
    case "$line" in '' | '#'*) continue ;; esac
    export "${line?}"
  done <"$f"
}

r2_require_env() {
  load_backup_env
  local v
  for v in R2_ENDPOINT R2_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
    [ -n "${!v:-}" ] || die "$v is not set. Fill $BULIG_BACKUP_ENV_FILE (names are in deploy/backup.env.example)."
  done
}

# r2_aws <aws args...>: aws against the R2 endpoint. Files for cp are always passed through r2_put / r2_get below.
r2_aws() {
  if command -v aws >/dev/null 2>&1; then
    aws --endpoint-url "$R2_ENDPOINT" "$@"
  else
    r2_docker "$@" </dev/null
  fi
}

# With docker there is no host mount at all (dockerd does not use this unit's private /tmp, so a -v folder would be a world-readable path on
# the host), and the R2 key is not in docker's environment or arguments either (both show in `docker inspect` and in ps). It goes in on
# stdin: two lines, then whatever data stream the caller supplies. The container's shell reads the two lines and starts aws.
r2_docker() {
  command -v docker >/dev/null 2>&1 || die "neither aws nor docker is installed, so there is no way to reach R2"
  {
    printf '%s\n%s\n' "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY"
    cat
  } | docker run --rm -i --entrypoint sh \
    -e "AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-auto}" \
    -e "AWS_REQUEST_CHECKSUM_CALCULATION=${AWS_REQUEST_CHECKSUM_CALCULATION:-when_required}" \
    -e "AWS_RESPONSE_CHECKSUM_VALIDATION=${AWS_RESPONSE_CHECKSUM_VALIDATION:-when_required}" \
    "$AWSCLI_IMAGE" -c 'read -r AWS_ACCESS_KEY_ID; read -r AWS_SECRET_ACCESS_KEY; export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; endpoint="$1"; shift; exec aws --endpoint-url "$endpoint" "$@"' sh "$R2_ENDPOINT" "$@"
}

# r2_put <local file> <key>
r2_put() {
  local file="$1" key="$2"
  if command -v aws >/dev/null 2>&1; then
    r2_aws s3 cp "$file" "s3://$R2_BUCKET/$key" --only-show-errors
  else
    r2_docker s3 cp - "s3://$R2_BUCKET/$key" --only-show-errors <"$file"
  fi
}

# r2_get <key> <local file>   (the file is created with the caller's umask: callers set 077 and use a private folder)
r2_get() {
  local key="$1" file="$2"
  if command -v aws >/dev/null 2>&1; then
    r2_aws s3 cp "s3://$R2_BUCKET/$key" "$file" --only-show-errors
  else
    r2_docker s3 cp "s3://$R2_BUCKET/$key" - --only-show-errors </dev/null >"$file"
  fi
}

# r2_size <key>: the object's byte size, or fail if the object is not there (the head-object check).
r2_size() {
  r2_aws s3api head-object --bucket "$R2_BUCKET" --key "$1" --query ContentLength --output text
}
