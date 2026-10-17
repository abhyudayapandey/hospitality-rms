#!/bin/bash
# Weekly security updates (ADR 171, review M51), Sunday 04:30 India time, as root. Amazon
# Linux 2023 pins its package repository to the image's release, so the security fixes come
# from --releasever=latest. A kernel or core library update needs a restart: the server then
# reboots (about a minute; everything comes back by itself).
set -euo pipefail
source "$(dirname "$0")/lib.sh"
dnf -y -q --releasever=latest upgrade --security
heartbeat os-patch true
if ! dnf -q needs-restarting -r > /dev/null 2>&1; then
  log "security updates need a restart: rebooting"
  systemctl --no-block reboot
fi
