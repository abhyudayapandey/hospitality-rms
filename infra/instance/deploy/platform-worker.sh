#!/bin/bash
# The platform worker as outletops-platform (ADR 012): claims queued platform jobs and
# runs them as platform_loader. LoadCredential provides only that password.
set -euo pipefail
pw=$(cat "$CREDENTIALS_DIRECTORY/db_platform_loader")
export PLATFORM_LOADER_DATABASE_URL="postgres://platform_loader:${pw}@127.0.0.1:5432/outlet_ops?sslmode=disable"
exec /opt/outlet-ops/current/node/bin/node /opt/outlet-ops/current/jobs/platform-worker.mjs
