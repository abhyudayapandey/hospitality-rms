#!/bin/bash
# Builds the Postgres 16 + pg_cron image and (re)creates the container when the image or
# config changed. Host networking + listen_addresses=127.0.0.1: never reachable from
# outside the instance. Data lives on the EBS data volume.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
REL_DIR=$1

docker build -q -t "$PG_IMAGE" "$REL_DIR/postgres" > /dev/null
install -d -m 0755 "$OO_ETC/postgres"
install -m 0644 "$REL_DIR/postgres/postgresql.conf" "$REL_DIR/postgres/pg_hba.conf" "$OO_ETC/postgres/"

# Superuser password: generated once, root-only, never used by the apps.
if [ ! -f "$OO_CREDS/postgres.env" ]; then
  (umask 077 && printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" > "$OO_CREDS/postgres.env")
fi

spec="$(docker image inspect -f '{{.Id}}' "$PG_IMAGE")#$(cat "$OO_ETC"/postgres/* | sha256sum | cut -c1-16)"
have=$(docker inspect -f '{{index .Config.Labels "outlet-ops.spec"}}' "$PG_CONTAINER" 2> /dev/null || true)
if [ "$spec" != "$have" ]; then
  log "starting Postgres container ($spec)"
  docker rm -f "$PG_CONTAINER" > /dev/null 2>&1 || true
  docker run -d --name "$PG_CONTAINER" --restart unless-stopped \
    --network host --shm-size 256m \
    --label "outlet-ops.spec=$spec" \
    --env-file "$OO_CREDS/postgres.env" -e POSTGRES_DB=outlet_ops \
    -v "$OO_DATA/pgdata:/var/lib/postgresql/data" \
    -v "$OO_ETC/postgres:/etc/postgresql:ro" \
    "$PG_IMAGE" -c config_file=/etc/postgresql/postgresql.conf > /dev/null
fi

for _ in $(seq 1 60); do
  docker exec "$PG_CONTAINER" pg_isready -q -h 127.0.0.1 -d outlet_ops && exit 0
  sleep 2
done
echo "Postgres did not become ready" >&2
docker logs --tail 50 "$PG_CONTAINER" >&2
exit 1
