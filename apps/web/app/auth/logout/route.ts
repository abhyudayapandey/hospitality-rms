import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { cognitoConfig, logoutUrl, revokeRefreshToken } from '@/lib/auth/cognito';
import { clearAuthCookies, sessionSecret } from '@/lib/auth/server';
import { REFRESH_COOKIE, SESSION_COOKIE, verifySession } from '@/lib/auth/session';

// Sign-out: revoke the Cognito refresh token (if any), clear the session, refresh and
// node cookies, and tell the browser to drop cached data. The sign-out button has
// already deleted the service-worker caches (Cache Storage) client-side.
export async function POST() {
  const jar = await cookies();
  const v = await verifySession(jar.get(SESSION_COOKIE)?.value, sessionSecret());
  const cfg = cognitoConfig();
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (cfg && refresh) {
    await revokeRefreshToken(cfg, refresh).catch(() => undefined);
  }
  await clearAuthCookies();
  const redirect = v.ok && v.payload.src === 'cognito' && cfg ? logoutUrl(cfg) : '/login';
  return NextResponse.json({ redirect }, { headers: { 'Clear-Site-Data': '"cache"' } });
}
