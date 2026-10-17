#!/bin/bash
# The server's own settings, applied by every deploy (ADR 170, review M46, H4); idempotent.
#  * Docker logs capped at 3 x 10 MB a container; the journal at 500 MB
#  * the metadata endpoint limited to the processes that need it (imds-guard.sh)
set -euo pipefail
source "$(dirname "$0")/lib.sh"
REL_DIR=$1

want='{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}'
if [ "$(cat /etc/docker/daemon.json 2> /dev/null)" != "$want" ]; then
  printf '%s\n' "$want" > /etc/docker/daemon.json
  log "Docker log limits set: restarting Docker (Postgres comes back by itself)"
  systemctl restart docker
fi

install -d -m 0755 /etc/systemd/journald.conf.d
want_j=$'[Journal]\nSystemMaxUse=500M'
if [ "$(cat /etc/systemd/journald.conf.d/outlet-ops.conf 2> /dev/null)" != "$want_j" ]; then
  printf '%s\n' "$want_j" > /etc/systemd/journald.conf.d/outlet-ops.conf
  systemctl restart systemd-journald
fi

"$REL_DIR/deploy/imds-guard.sh"
