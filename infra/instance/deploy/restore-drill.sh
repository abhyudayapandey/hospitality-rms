#!/bin/bash
# Restore drill (docs/deploy.md): restores a pg_dump from S3 into a scratch database,
# compares row counts with the live database, then drops the scratch database.
# Usage: restore-drill.sh [s3-key]   (default: latest dump)
set -euo pipefail
source "$(dirname "$0")/lib.sh"
source "$OO_ETC/backup.env"
DRILL_DB=outlet_ops_restore_drill

KEY=${1:-$(aws s3api list-objects-v2 --bucket "$BACKUP_BUCKET" --prefix pg/ \
  --query 'reverse(sort_by(Contents, &LastModified))[0].Key' --output text)}
[ -n "$KEY" ] && [ "$KEY" != "None" ] || { echo "no backups found" >&2; exit 1; }
log "restoring s3://$BACKUP_BUCKET/$KEY into $DRILL_DB"

TMP=$(mktemp)
trap 'rm -f "$TMP"; docker exec "$PG_CONTAINER" rm -f /tmp/drill.dump /tmp/drill.list || true' EXIT
aws s3 cp "s3://$BACKUP_BUCKET/$KEY" "$TMP" --only-show-errors
docker cp "$TMP" "$PG_CONTAINER:/tmp/drill.dump"
docker exec "$PG_CONTAINER" chown postgres /tmp/drill.dump

psql_super -d postgres -c "drop database if exists $DRILL_DB" -c "create database $DRILL_DB"
# pg_cron can only live in outlet_ops (cron.database_name), so skip it in the drill copy.
docker exec -u postgres "$PG_CONTAINER" sh -c \
  "pg_restore -l /tmp/drill.dump | grep -v pg_cron > /tmp/drill.list"
docker exec -u postgres "$PG_CONTAINER" pg_restore --exit-on-error -L /tmp/drill.list \
  -d "$DRILL_DB" /tmp/drill.dump

printf '%-40s %12s %12s\n' check live restored
fail=0
for q in "select count(*) from core.app_user" "select count(*) from core.hierarchy_node" \
  "select count(*) from core.role_assignment" "select count(*) from wf.request" \
  "select count(*) from audit.log" "select max(version) from public.schema_migrations"; do
  live=$(psql_super -d outlet_ops -At -c "$q")
  restored=$(psql_super -d "$DRILL_DB" -At -c "$q")
  printf '%-40s %12s %12s\n' "${q#select }" "$live" "$restored"
  # Every check must return a value from the restored copy. Live may have moved on
  # since the dump, so the numbers are shown side by side for the operator to judge.
  [ -n "$restored" ] || fail=1
done
psql_super -d postgres -c "drop database $DRILL_DB"
[ "$fail" = 0 ] && log "restore drill passed for $KEY" || { log "restore drill FAILED"; exit 1; }
