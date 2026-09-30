#!/bin/bash
# Fetches SSM parameters into root-only files. systemd LoadCredential then hands each
# service only its own secret (web: app_rw + session; wf-execute: wf_executor;
# platform worker: platform_loader).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

get() {
  aws ssm get-parameter --with-decryption --name "$1" --query Parameter.Value --output text
}
write_secret() { # PARAM FILE
  local v
  v=$(get "$1")
  if ! [[ "$v" =~ ^[0-9a-f]{64}$ ]]; then
    echo "parameter $1 must be 64 hex characters (infra/scripts/create-secrets.sh)" >&2
    exit 1
  fi
  (umask 077 && printf '%s' "$v" > "$2.tmp" && mv -f "$2.tmp" "$2")
}

install -d -m 0700 "$OO_CREDS"
write_secret "$PARAM_PREFIX/db/migrator" "$OO_CREDS/migrator"
write_secret "$PARAM_PREFIX/db/app_rw" "$OO_CREDS/app_rw"
write_secret "$PARAM_PREFIX/db/wf_executor" "$OO_CREDS/wf_executor"
write_secret "$PARAM_PREFIX/db/platform_loader" "$OO_CREDS/platform_loader"
write_secret "$PARAM_PREFIX/web/session_secret" "$OO_CREDS/session_secret"

# Non-secret config (String parameters from the CDK stack).
declare -A cfg
while IFS=$'\t' read -r name value; do
  cfg[${name##*/}]=$value
done < <(aws ssm get-parameters-by-path --path "$PARAM_PREFIX/config" \
  --query 'Parameters[].[Name,Value]' --output text)
for key in app_url app_domain acme_email cognito_user_pool_id cognito_client_id cognito_domain \
  platform_cognito_user_pool_id platform_cognito_client_id platform_cognito_domain \
  backup_bucket photo_bucket; do
  [ -n "${cfg[$key]:-}" ] || { echo "missing config parameter $key" >&2; exit 1; }
done

install -d -m 0755 "$OO_ETC"
cat > "$OO_ETC/web.env" <<ENV
NODE_ENV=production
PORT=3000
HOSTNAME=127.0.0.1
APP_URL=${cfg[app_url]}
COGNITO_USER_POOL_ID=${cfg[cognito_user_pool_id]}
COGNITO_CLIENT_ID=${cfg[cognito_client_id]}
COGNITO_DOMAIN=${cfg[cognito_domain]}
PLATFORM_COGNITO_USER_POOL_ID=${cfg[platform_cognito_user_pool_id]}
PLATFORM_COGNITO_CLIENT_ID=${cfg[platform_cognito_client_id]}
PLATFORM_COGNITO_DOMAIN=${cfg[platform_cognito_domain]}
PHOTO_BUCKET=${cfg[photo_bucket]}
AWS_REGION=${AWS_REGION}
ENV
# The platform worker's config: no secrets (its database password comes by LoadCredential).
cat > "$OO_ETC/platform-worker.env" <<ENV
NODE_ENV=production
COGNITO_USER_POOL_ID=${cfg[cognito_user_pool_id]}
PHOTO_BUCKET=${cfg[photo_bucket]}
AWS_REGION=${AWS_REGION}
ENV
cat > "$OO_ETC/caddy.env" <<ENV
APP_DOMAIN=${cfg[app_domain]}
ACME_EMAIL=${cfg[acme_email]}
ENV
cat > "$OO_ETC/backup.env" <<ENV
BACKUP_BUCKET=${cfg[backup_bucket]}
ENV
log "parameters fetched"
