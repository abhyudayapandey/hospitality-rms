#!/bin/bash
# One executor pass as outletops-wf (systemd timer, every minute). LoadCredential
# provides only the wf_executor password.
set -euo pipefail
pw=$(cat "$CREDENTIALS_DIRECTORY/db_wf_executor")
export WF_EXECUTOR_DATABASE_URL="postgres://wf_executor:${pw}@127.0.0.1:5432/outlet_ops?sslmode=disable"
exec /opt/outlet-ops/current/node/bin/node /opt/outlet-ops/current/jobs/wf-execute.mjs --once
