#!/bin/bash
# Every 15 minutes as root (ADR 170): the disks, the app and the platform worker. Records the
# app's and the worker's heartbeats when they answer; fails (and so emails, through OnFailure)
# when a disk is 85 % full or either is down. Its own heartbeat follows a clean run.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
problems=()

for mount in / "$OO_DATA"; do
  used=$(df --output=pcent "$mount" | tail -n 1 | tr -dc '0-9')
  if [ "${used:-0}" -ge 85 ]; then problems+=("disk $mount is ${used}% full"); fi
done

if curl -fsS -m 10 -o /dev/null http://127.0.0.1:3000/health/db; then
  heartbeat web true
else
  problems+=("the app does not answer (outlet-ops-web)")
fi

if systemctl is-active -q outlet-ops-platform-worker.service; then
  heartbeat platform-worker true
else
  problems+=("the platform worker is not running")
fi

if [ ${#problems[@]} -gt 0 ]; then
  printf '%s\n' "${problems[@]}" >&2
  exit 1
fi
log "watchdog: all well"
