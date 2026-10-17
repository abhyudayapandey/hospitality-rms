#!/bin/bash
# pg_dump (custom format) every 6 hours (ADR 170, review M44): dumped to a file, checked with
# pg_restore -l, and only then uploaded, so a dump cut short never becomes the newest backup.
# The bucket keeps dumps 35 days under Object Lock; the first dump of each month also goes to
# pg-monthly/, locked and kept 7 years. S3 copies both to Hyderabad.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
source "$OO_ETC/backup.env"

WORK="$OO_DATA/backup-tmp"
install -d -m 0700 "$WORK"
FILE="$WORK/outlet_ops.dump"
trap 'rm -f "$FILE"' EXIT
docker exec -u postgres "$PG_CONTAINER" pg_dump -Fc -d outlet_ops > "$FILE"
# a cut-off or corrupt dump fails here (its table of contents cannot be read)
docker exec -i -u postgres "$PG_CONTAINER" pg_restore -l < "$FILE" > /dev/null
[ -s "$FILE" ] || { echo "the dump is empty" >&2; exit 1; }

# Object Lock needs a checksum on every upload.
md5=$(openssl md5 -binary "$FILE" | base64)
put() { # KEY [extra put-object arguments]
  local key=$1
  shift
  aws s3api put-object --bucket "$BACKUP_BUCKET" --key "$key" --body "$FILE" \
    --content-md5 "$md5" "$@" > /dev/null
  log "backup uploaded to s3://$BACKUP_BUCKET/$key ($(du -h "$FILE" | cut -f1))"
}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
put "pg/$(date -u +%Y/%m/%d)/outlet_ops-$STAMP.dump"

MONTH=$(date -u +%Y/%m)
have=$(aws s3api list-objects-v2 --bucket "$BACKUP_BUCKET" --prefix "pg-monthly/$MONTH/" \
  --max-keys 1 --query 'KeyCount' --output text)
if [ "$have" = 0 ]; then
  put "pg-monthly/$MONTH/outlet_ops-$STAMP.dump" --object-lock-mode GOVERNANCE \
    --object-lock-retain-until-date "$(date -u -d '+2557 days' +%Y-%m-%dT%H:%M:%SZ)"
fi
