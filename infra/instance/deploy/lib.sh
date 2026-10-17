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

# Alerts and heartbeats (ADR 170). Root only: they use the instance role and the superuser.
OO_ALERTS=/var/lib/outlet-ops/alerts

# heartbeat JOB OK [NOTE]: records a run in platform.job_heartbeat. Never fails its caller:
# a database that does not answer is reported by the outside check and the watchdog.
heartbeat() {
  local note=${3:-}
  # on stdin, not -c: psql fills in :'var' only in what it reads, never in -c
  echo "select platform.job_ran(:'job', :'ok'::boolean, nullif(:'note', ''));" |
    psql_super -d outlet_ops -v job="$1" -v ok="$2" -v note="$note" > /dev/null 2>&1 ||
    log "could not record $1 ($2) in the database"
}

# alert KEY SUBJECT BODY: emails the alert address through the SNS topic, at most once an
# hour for the same KEY (a job failing every minute sends one email, not sixty).
alert() {
  local key=$1 subject=$2 body=$3 stamp
  install -d -m 0700 "$OO_ALERTS"
  stamp="$OO_ALERTS/${key//[^A-Za-z0-9._-]/_}"
  if [ -f "$stamp" ] && [ -n "$(find "$stamp" -mmin -60)" ]; then
    log "alert for $key already sent within the hour: $subject"
    return 0
  fi
  local topic=
  [ -f "$OO_ETC/alert.env" ] && topic=$(sed -n 's/^ALERT_TOPIC_ARN=//p' "$OO_ETC/alert.env")
  if [ -z "$topic" ]; then
    log "no alert topic (fetch-params has not run): $subject"
    return 0
  fi
  if aws sns publish --topic-arn "$topic" --subject "${subject:0:99}" \
    --message "$body" > /dev/null; then
    touch "$stamp"
    log "alert sent: $subject"
  else
    log "could not send the alert: $subject"
  fi
}
