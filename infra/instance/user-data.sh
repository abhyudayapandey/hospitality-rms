#!/bin/bash
# Outlet Ops instance: first-boot base setup (cloud-init, as root). Application pieces
# (Node runtime, Caddy, Postgres container, systemd units) arrive with each release
# bundle and are installed by deploy/deploy.sh. See docs/deploy.md and ADR 005.
set -euxo pipefail

DATA_VOLUME_ID="__DATA_VOLUME_ID__"
DATA_DIR=/var/lib/outlet-ops

dnf -y install docker
systemctl enable --now docker

# 2 GiB swap: t4g.small has 2 GiB RAM shared by Postgres, Next.js and the workers.
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
swapon -a
echo 'vm.swappiness=10' > /etc/sysctl.d/90-outlet-ops.conf
sysctl --system

# Service users (no login shell). Each service gets only its own credentials.
for u in outletops-web outletops-wf; do
  id "$u" >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin "$u"
done

# Separate EBS data volume for Postgres (survives instance replacement, snapshotted by
# DLM). Formatted only when blank.
DEV="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${DATA_VOLUME_ID/-/}"
for _ in $(seq 1 60); do [ -e "$DEV" ] && break; sleep 5; done
test -e "$DEV"
blkid "$DEV" >/dev/null 2>&1 || mkfs.xfs -L outletops-data "$DEV"
mkdir -p "$DATA_DIR"
grep -q 'LABEL=outletops-data' /etc/fstab ||
  echo "LABEL=outletops-data $DATA_DIR xfs defaults,nofail 0 2" >> /etc/fstab
mount -a

mkdir -p "$DATA_DIR/pgdata" /opt/outlet-ops/releases /etc/outlet-ops/creds
chmod 700 /etc/outlet-ops/creds
