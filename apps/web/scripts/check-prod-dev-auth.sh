#!/usr/bin/env bash
# Proves dev-only auth cannot reach production (ADR 004):
#  1. a production build with DEV_AUTH_STUB=true is refused
#  2. a production build started WITH DEV_AUTH_STUB=true at runtime still returns 404
#     for /dev-login and the dev-only test request form (even with a valid session)
# Needs DATABASE_URL (app_rw) and a seeded database for step 2's signed-in check.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${CHECK_PORT:-3200}"
SECRET="check-prod-session-secret-0123456789-abcdef"

echo "1/3 production build with DEV_AUTH_STUB=true must fail"
if DEV_AUTH_STUB=true pnpm exec next build > /tmp/oo-build-devauth.log 2>&1; then
  echo "FAIL: build succeeded with DEV_AUTH_STUB=true"; exit 1
fi
grep -q "DEV_AUTH_STUB=true is not allowed" /tmp/oo-build-devauth.log
echo "   ok: refused"

echo "2/3 production build"
env -u DEV_AUTH_STUB pnpm exec next build > /tmp/oo-build.log 2>&1 || { tail -40 /tmp/oo-build.log; exit 1; }
echo "   ok: built"

echo "3/3 start with DEV_AUTH_STUB=true and probe"
DEV_AUTH_STUB=true SESSION_SECRET="$SECRET" PORT="$PORT" pnpm exec next start > /tmp/oo-start.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf -o /dev/null "http://localhost:$PORT/login" && break; sleep 1; done

COOKIE=$(SESSION_SECRET="$SECRET" pnpm exec tsx -e "
import { newSession, signSession } from './lib/auth/session.ts';
signSession(newSession('01920000-0000-7000-8000-000000000303', 'dev'), process.env.SESSION_SECRET!)
  .then((t) => process.stdout.write(t));")

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
check() {
  local got; got=$(status "${@:2}")
  if [ "$got" != "$1" ]; then echo "FAIL: expected $1, got $got for ${*:2}"; exit 1; fi
  echo "   ok: $got ${*: -1}"
}
check 404 "http://localhost:$PORT/dev-login"
check 404 -b "oo_session=$COOKIE" "http://localhost:$PORT/dev-login"
check 404 -b "oo_session=$COOKIE" "http://localhost:$PORT/requests/new"
check 200 -b "oo_session=$COOKIE" "http://localhost:$PORT/requests"   # control: the app works
if curl -s "http://localhost:$PORT/login" | grep -q "Dev login"; then
  echo "FAIL: login page links to dev login"; exit 1
fi
echo "   ok: login page has no dev login link"
echo "PASS: dev auth is unreachable in production"
