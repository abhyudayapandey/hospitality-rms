# Shared settings for the Outlet Ops instance scripts (sourced, not executed).
# shellcheck shell=bash
export AWS_REGION=ap-south-1 AWS_DEFAULT_REGION=ap-south-1
OO_ROOT=/opt/outlet-ops
OO_ETC=/etc/outlet-ops
OO_CREDS=/etc/outlet-ops/creds
OO_DATA=/var/lib/outlet-ops
PARAM_PREFIX=/outlet-ops/prod
PG_CONTAINER=outlet-ops-pg
PG_IMAGE=outlet-ops-postgres:16

log() { echo "[outlet-ops $(date -u +%FT%TZ)] $*"; }

# db_url ROLE PASSWORD_FILE -> loopback connection URL (passwords are hex, URL-safe).
db_url() {
  local pw
  pw=$(cat "$2")
  printf 'postgres://%s:%s@127.0.0.1:5432/outlet_ops?sslmode=disable' "$1" "$pw"
}

# Superuser psql inside the container over the local socket (peer auth, root only).
psql_super() {
  docker exec -i -u postgres "$PG_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 "$@"
}
