#!/bin/bash
# Creates the SecureString parameters (standard tier, AWS-managed aws/ssm key: free)
# that the instance reads. Run once from an admin machine before the first deploy.
# Values never appear on a command line (read from a 0600 temp file).
#   infra/scripts/create-secrets.sh                    create any that are missing
#   infra/scripts/create-secrets.sh --rotate db/app_rw  replace one, then redeploy
set -euo pipefail
export AWS_REGION=ap-south-1
PREFIX=/outlet-ops/prod
NAMES=(db/migrator db/app_rw db/wf_executor db/platform_loader web/session_secret)
ROTATE=
[ "${1:-}" = "--rotate" ] && ROTATE=${2:?--rotate needs a name, e.g. db/app_rw}

put() {
  local name="$PREFIX/$1" tmp
  if aws ssm get-parameter --name "$name" > /dev/null 2>&1 && [ "$ROTATE" != "$1" ]; then
    echo "exists:  $name"
    return
  fi
  tmp=$(mktemp)
  chmod 600 "$tmp"
  printf '{"Name":"%s","Type":"SecureString","Tier":"Standard","Overwrite":true,"Value":"%s"}' \
    "$name" "$(openssl rand -hex 32)" > "$tmp"
  aws ssm put-parameter --cli-input-json "file://$tmp" > /dev/null
  rm -f "$tmp"
  echo "written: $name"
}

for n in "${NAMES[@]}"; do put "$n"; done
