#!/bin/bash
# pg_dump (custom format) streamed to S3 every 6 hours. Kept 30 days (bucket lifecycle).
set -euo pipefail
source "$(dirname "$0")/lib.sh"
source "$OO_ETC/backup.env"

KEY="pg/$(date -u +%Y/%m/%d)/outlet_ops-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec -u postgres "$PG_CONTAINER" pg_dump -Fc -d outlet_ops |
  aws s3 cp - "s3://$BACKUP_BUCKET/$KEY" --only-show-errors
log "backup uploaded to s3://$BACKUP_BUCKET/$KEY"
