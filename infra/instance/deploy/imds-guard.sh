#!/bin/bash
# The instance's AWS credentials (the metadata endpoint) only for the processes that need
# them (ADR 170, review H4): root (fetch-params, backups, alerts, the SSM agent), the web app
# (photos, logins) and the platform worker (uploads, invitations). The jobs' user, Postgres
# and any container are refused, so a bug there cannot read the secrets. Run at boot (unit
# outlet-ops-imds-guard) and by every deploy; idempotent.
set -euo pipefail
IMDS=169.254.169.254
iptables -w -N OO-IMDS 2> /dev/null || iptables -w -F OO-IMDS
iptables -w -A OO-IMDS -m owner --uid-owner 0 -j RETURN
for u in outletops-web outletops-platform; do
  iptables -w -A OO-IMDS -m owner --uid-owner "$(id -u "$u")" -j RETURN
done
iptables -w -A OO-IMDS -j REJECT
iptables -w -C OUTPUT -d "$IMDS" -j OO-IMDS 2> /dev/null ||
  iptables -w -I OUTPUT -d "$IMDS" -j OO-IMDS
# containers on a Docker network (none today: Postgres uses the host's network)
if iptables -w -n -L DOCKER-USER > /dev/null 2>&1; then
  iptables -w -C DOCKER-USER -d "$IMDS" -j REJECT 2> /dev/null ||
    iptables -w -I DOCKER-USER -d "$IMDS" -j REJECT
fi
echo "metadata endpoint limited to root, outletops-web and outletops-platform"
