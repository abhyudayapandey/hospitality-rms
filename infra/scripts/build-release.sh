#!/bin/bash
# Builds the linux-arm64 release bundle in CI (the instance never builds anything):
#   node/  Node 22 runtime (checksum-verified)   bin/  caddy, dbmate
#   web/   Next.js standalone server             jobs/ wf-execute, sync-defs, attendance-nightly,
#                                                      platform-worker
#   migrations/  deploy/  systemd/  postgres/  caddy/
# Usage: infra/scripts/build-release.sh <git-sha>   -> dist/release-<sha>.tgz
set -euo pipefail
SHA=${1:?usage: build-release.sh <git-sha>}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$ROOT/dist/release"
CADDY_VERSION=${CADDY_VERSION:-2.11.4}
DBMATE_VERSION=$(node -p "require('$ROOT/package.json').devDependencies.dbmate.replace(/^[^0-9]*/, '')")
NODE_MAJOR=22

rm -rf "$OUT" && mkdir -p "$OUT"/{bin,jobs,node} "$ROOT/dist/cache"
cd "$ROOT"
echo "$SHA" > "$OUT/VERSION"

echo "== Next.js standalone build (production, dev auth compiled out)"
env -u DEV_AUTH_STUB NEXT_TELEMETRY_DISABLED=1 pnpm --filter @outlet-ops/web build
mkdir -p "$OUT/web"
cp -a apps/web/.next/standalone/. "$OUT/web/"
cp -a apps/web/.next/static "$OUT/web/apps/web/.next/static"
cp -a apps/web/public "$OUT/web/apps/web/public"

echo "== Job bundles (esbuild)"
banner="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
for job in execute:wf-execute sync-defs:sync-defs attendance-nightly:attendance-nightly; do
  pnpm --filter @outlet-ops/workflow exec esbuild "scripts/${job%%:*}.ts" --bundle \
    --platform=node --target=node22 --format=esm --banner:js="$banner" \
    --outfile="$OUT/jobs/${job##*:}.mjs" --log-level=warning
done
# the platform worker (ADR 012): creates customers queued in the platform console
# (the workflow package's esbuild; imports resolve from the onboarding package)
pnpm --filter @outlet-ops/workflow exec esbuild ../onboarding/scripts/worker.ts --bundle \
  --platform=node --target=node22 --format=esm --banner:js="$banner" \
  --outfile="$OUT/jobs/platform-worker.mjs" --log-level=warning

echo "== Node $NODE_MAJOR runtime (linux-arm64)"
NODE_VERSION=${NODE_VERSION:-$(curl -fsSL https://nodejs.org/dist/index.json |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).find(r=>r.version.startsWith('v$NODE_MAJOR.')).version))")}
NODE_TGZ="node-$NODE_VERSION-linux-arm64.tar.xz"
(cd dist/cache &&
  curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/$NODE_TGZ" &&
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep " $NODE_TGZ\$" | sha256sum -c -)
tar -xJf "dist/cache/$NODE_TGZ" -C "$OUT/node" --strip-components=1
rm -rf "$OUT/node/include" "$OUT/node/share" "$OUT/node/lib/node_modules/npm" "$OUT/node/lib/node_modules/corepack"
echo "$NODE_VERSION" > "$OUT/node/VERSION"

echo "== Caddy $CADDY_VERSION (linux-arm64)"
CADDY_TGZ="caddy_${CADDY_VERSION}_linux_arm64.tar.gz"
(cd dist/cache &&
  curl -fsSLO "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/$CADDY_TGZ" &&
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_checksums.txt" |
  grep " $CADDY_TGZ\$" | sha512sum -c -)
tar -xzf "dist/cache/$CADDY_TGZ" -C "$OUT/bin" caddy

echo "== dbmate $DBMATE_VERSION (linux-arm64, from npm)"
(cd dist/cache && npm pack --silent "@dbmate/linux-arm64@$DBMATE_VERSION" > /dev/null)
tar -xzf "dist/cache/dbmate-linux-arm64-$DBMATE_VERSION.tgz" -C dist/cache package/bin/dbmate
install -m 0755 dist/cache/package/bin/dbmate "$OUT/bin/dbmate"

echo "== Migrations and instance files"
cp -a packages/db/migrations "$OUT/migrations"
cp -a infra/instance/deploy infra/instance/systemd infra/instance/postgres infra/instance/caddy "$OUT/"
chmod 0755 "$OUT"/deploy/*.sh
chmod 0644 "$OUT/deploy/lib.sh"

tar -czf "dist/release-$SHA.tgz" -C "$OUT" .
echo "built dist/release-$SHA.tgz ($(du -h "dist/release-$SHA.tgz" | cut -f1))"
