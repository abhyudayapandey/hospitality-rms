#!/bin/bash
# Installs a release on the instance (run as root by the OutletOps-Deploy SSM document).
# Idempotent: units, parameters, Postgres, roles, migrations (forward-only), process
# definitions, then an atomic symlink switch and a health check with rollback of the
# app code (not of migrations). Builds happen in CI only; nothing is compiled here.
set -euo pipefail
REL=$1
REL_DIR=/opt/outlet-ops/releases/$REL
source "$REL_DIR/deploy/lib.sh"
log "deploying $REL"

install -m 0755 "$REL_DIR/bin/caddy" /usr/local/bin/caddy
install -m 0644 "$REL_DIR"/systemd/* /etc/systemd/system/
install -d -m 0755 "$OO_ETC"
install -m 0644 "$REL_DIR/caddy/Caddyfile" "$OO_ETC/Caddyfile"
systemctl daemon-reload

"$REL_DIR/deploy/fetch-params.sh"
"$REL_DIR/deploy/postgres-up.sh" "$REL_DIR"
"$REL_DIR/deploy/bootstrap-db.sh"

MIG_URL=$(db_url migrator "$OO_CREDS/migrator")
DATABASE_URL="$MIG_URL" "$REL_DIR/bin/dbmate" \
  --migrations-dir "$REL_DIR/migrations" --no-dump-schema up
MIGRATOR_DATABASE_URL="$MIG_URL" "$REL_DIR/node/bin/node" "$REL_DIR/jobs/sync-defs.mjs"

PREV=$(readlink -f "$OO_ROOT/current" 2> /dev/null || true)
ln -sfn "$REL_DIR" "$OO_ROOT/current.new"
mv -T "$OO_ROOT/current.new" "$OO_ROOT/current"

systemctl enable -q outlet-ops-caddy.service outlet-ops-web.service \
  outlet-ops-wf-execute.timer outlet-ops-pg-backup.timer outlet-ops-attendance-nightly.timer
systemctl restart outlet-ops-web.service
systemctl reload-or-restart outlet-ops-caddy.service
systemctl start outlet-ops-wf-execute.timer outlet-ops-pg-backup.timer \
  outlet-ops-attendance-nightly.timer

ok=
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:3000/login; then ok=1 && break; fi
  sleep 2
done
if [ -z "$ok" ]; then
  log "health check failed for $REL"
  if [ -n "$PREV" ] && [ "$PREV" != "$REL_DIR" ]; then
    ln -sfn "$PREV" "$OO_ROOT/current.new" && mv -T "$OO_ROOT/current.new" "$OO_ROOT/current"
    systemctl restart outlet-ops-web.service
    log "rolled back app code to $PREV (migrations stay applied)"
  fi
  exit 1
fi

# Keep the three most recent releases.
find "$OO_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
  sort -rn | tail -n +4 | cut -d' ' -f2- | xargs -r rm -rf
log "deployed $REL"
