#!/bin/bash
# One executor pass as outletops-wf (systemd timer, every minute). LoadCredential
# provides only the wf_executor password.
set -euo pipefail
pw=$(cat "$CREDENTIALS_DIRECTORY/db_wf_executor")
export WF_EXECUTOR_DATABASE_URL="postgres://wf_executor:${pw}@127.0.0.1:5432/outlet_ops?sslmode=disable"
# Web Push (ADR 137): empty when the key was never created, and then nothing is pushed
if [ -s "$CREDENTIALS_DIRECTORY/vapid_private" ]; then
  VAPID_PRIVATE_KEY=$(cat "$CREDENTIALS_DIRECTORY/vapid_private")
  export VAPID_PRIVATE_KEY
fi
exec /opt/outlet-ops/current/node/bin/node /opt/outlet-ops/current/jobs/wf-execute.mjs --once
