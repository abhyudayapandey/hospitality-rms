#!/usr/bin/env bash
# Proves dev-only auth cannot reach production (ADR 004):
#  1. a production build with DEV_AUTH_STUB=true is refused
#  2. the standalone server (the artifact the release ships) started WITH
#     DEV_AUTH_STUB=true at runtime still returns 404 for /dev-login (even with a valid
#     session)
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

echo "3/3 start the standalone server with DEV_AUTH_STUB=true and probe"
DEV_AUTH_STUB=true SESSION_SECRET="$SECRET" PORT="$PORT" BIND_HOST=127.0.0.1 \
  bash scripts/start-standalone.sh > /tmp/oo-start.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/login" && break; sleep 1; done

# a test user (docs/onboarding/test-data), resolved as the app does before sign-in
COOKIE=$(SESSION_SECRET="$SECRET" pnpm exec tsx -e "
import pg from 'pg';
import { newSession, signSession } from './lib/auth/session.ts';
(async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows } = await db.query(
    \"select core.user_for_username('TEST-COMPANY', 'test.head-cook.3.0') as id\");
  await db.end();
  if (!rows[0]?.id) throw new Error('test user not found (run pnpm db:seed)');
  const token = await signSession(newSession(rows[0].id, 'dev'), process.env.SESSION_SECRET!);
  process.stdout.write(token);
})();")

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
check() {
  local got; got=$(status "${@:2}")
  if [ "$got" != "$1" ]; then echo "FAIL: expected $1, got $got for ${*:2}"; exit 1; fi
  echo "   ok: $got ${*: -1}"
}
check 404 "http://127.0.0.1:$PORT/dev-login"
check 404 -b "oo_session=$COOKIE" "http://127.0.0.1:$PORT/dev-login"
check 200 -b "oo_session=$COOKIE" "http://127.0.0.1:$PORT/requests"   # control: the app works
if curl -s "http://127.0.0.1:$PORT/login" | grep -q "Dev login"; then
  echo "FAIL: login page links to dev login"; exit 1
fi
echo "   ok: login page has no dev login link"
echo "PASS: dev auth is unreachable in production"
