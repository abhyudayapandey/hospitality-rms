#!/bin/bash
# A unit failed (systemd OnFailure=outlet-ops-notify@%n.service, ADR 170): records the failure
# against its job and emails the alert address the unit's last 30 log lines, at most once an
# hour per unit. Usage: notify.sh <unit>
set -euo pipefail
source "$(dirname "$0")/lib.sh"
UNIT=${1:?usage: notify.sh <unit>}
JOB=${UNIT#outlet-ops-}
JOB=${JOB%.service}
LINES=$(journalctl -u "$UNIT" -n 30 --no-pager -o short-iso 2> /dev/null || true)
heartbeat "$JOB" false "$(printf '%s' "$LINES" | tail -n 3)"
alert "$UNIT" "Hey Senior server: $JOB failed" "$(
  cat << MSG
$JOB failed on the Hey Senior server at $(TZ=Asia/Kolkata date '+%d/%m/%Y %H:%M') India time.

The platform console's "The server" card shows every job. On the server:
  journalctl -u $UNIT -n 100

Its last 30 log lines:
$LINES
MSG
)"
