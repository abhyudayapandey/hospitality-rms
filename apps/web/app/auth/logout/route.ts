import { cookies } from 'next/headers';
import { after, NextResponse } from 'next/server';
import { cognitoConfig, logoutUrl, revokeRefreshToken } from '@/lib/auth/cognito';
import { clearAuthCookies, sessionSecret } from '@/lib/auth/server';
import { REFRESH_COOKIE, SESSION_COOKIE, verifySession } from '@/lib/auth/session';

// Sign-out: clear the session, refresh and node cookies, tell the browser to drop cached
// data, and answer at once; the Cognito refresh token is revoked just after (ADR 056), so the
// phone does not wait on Cognito. The sign-out button clears the service-worker caches
// (Cache Storage) at the same time.
export async function POST() {
  const jar = await cookies();
  const v = await verifySession(jar.get(SESSION_COOKIE)?.value, sessionSecret());
  const cfg = cognitoConfig();
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (cfg && refresh) {
    after(() => revokeRefreshToken(cfg, refresh).catch(() => undefined));
  }
  await clearAuthCookies();
  const redirect = v.ok && v.payload.src === 'cognito' && cfg ? logoutUrl(cfg) : '/login';
  return NextResponse.json({ redirect }, { headers: { 'Clear-Site-Data': '"cache"' } });
}
