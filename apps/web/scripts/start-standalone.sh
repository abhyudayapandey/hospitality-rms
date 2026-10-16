#!/usr/bin/env bash
# Starts the production standalone server, the same artifact the release bundle ships
# (infra/scripts/build-release.sh). Needs a prior `next build`. Like the release, it
# copies static assets and public/ next to server.js, which the standalone output omits.
# Env: PORT (default 3000), BIND_HOST (default 127.0.0.1; not HOSTNAME, which shells and
# CI runners preset to the machine name), STANDALONE_ASSETS_READY (skip the copy), plus
# the app's runtime env.
set -euo pipefail
cd "$(dirname "$0")/.."
APP=.next/standalone/apps/web
[ -f "$APP/server.js" ] || { echo "no standalone build; run next build first" >&2; exit 1; }
# a second server on the same build (the sign-in e2e tests) skips the copy, so the two
# never copy at once
if [ -z "${STANDALONE_ASSETS_READY:-}" ]; then
  rm -rf "$APP/.next/static" "$APP/public"
  cp -a .next/static "$APP/.next/static"
  cp -a public "$APP/public"
fi
export HOSTNAME="${BIND_HOST:-127.0.0.1}"
exec node "$APP/server.js"
