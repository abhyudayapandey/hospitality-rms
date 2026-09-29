#!/bin/bash
# Starts Next.js as outletops-web. systemd LoadCredential provides only app_rw and the
# session secret in $CREDENTIALS_DIRECTORY.
set -euo pipefail
pw=$(cat "$CREDENTIALS_DIRECTORY/db_app_rw")
export DATABASE_URL="postgres://app_rw:${pw}@127.0.0.1:5432/outlet_ops?sslmode=disable"
SESSION_SECRET=$(cat "$CREDENTIALS_DIRECTORY/session_secret")
export SESSION_SECRET
exec /opt/outlet-ops/current/node/bin/node /opt/outlet-ops/current/web/apps/web/server.js
