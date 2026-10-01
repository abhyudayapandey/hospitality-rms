import { NextResponse, type NextRequest } from 'next/server';
import { appUrl } from './lib/app-url';
import { cognitoConfig, refreshTokens, verifyIdToken } from './lib/auth/cognito';
import {
  COGNITO_REFRESH_AFTER_S,
  PLACE_COOKIE,
  REFRESH_COOKIE,
  SESSION_COOKIE,
  TOUCH_AFTER_S,
  nowSeconds,
  sessionMaxAge,
  signSession,
  verifySession,
} from './lib/auth/session';
import {
  PLATFORM_COOKIE,
  PLATFORM_TOUCH_AFTER_S,
  platformCookie,
  platformMaxAge,
  signPlatformSession,
  verifyPlatformSession,
} from './lib/platform/session';

// Optimistic session handling before render (ADR 004):
//  * no valid session -> /login (the data layer re-checks the user on every request)
//  * idle timeout 12 h (sliding), absolute 30 days
//  * Cognito sessions are re-validated hourly with the refresh token (rotation-aware)

const secure = process.env.NODE_ENV === 'production';

function toLogin(req: NextRequest, reason: string): NextResponse {
  const url = appUrl('/login');
  url.searchParams.set('reason', reason);
  const res = NextResponse.redirect(url);
  for (const name of [SESSION_COOKIE, REFRESH_COOKIE, PLACE_COOKIE]) res.cookies.delete(name);
  return res;
}

/**
 * The platform console (ADR 012) is a separate world: only a platform session (its own
 * cookie, limited to /platform) opens it, and a customer session never does. A platform
 * session opens nothing outside /platform, since its cookie is never sent there.
 */
async function platformProxy(req: NextRequest, secret: string): Promise<NextResponse> {
  const path = req.nextUrl.pathname;
  if (
    path.startsWith('/platform/auth/') ||
    path === '/platform/signin' ||
    path === '/platform/signed-out'
  ) {
    return NextResponse.next();
  }
  const now = nowSeconds();
  const v = await verifyPlatformSession(req.cookies.get(PLATFORM_COOKIE)?.value, secret, now);
  if (!v.ok) {
    const res = NextResponse.redirect(appUrl(`/platform/signin?reason=${v.reason}`));
    res.cookies.delete({ name: PLATFORM_COOKIE, path: '/platform' });
    return res;
  }
  const res = NextResponse.next();
  if (now - v.payload.seen > PLATFORM_TOUCH_AFTER_S) {
    const payload = { ...v.payload, seen: now };
    res.cookies.set(PLATFORM_COOKIE, await signPlatformSession(payload, secret), {
      ...platformCookie,
      maxAge: platformMaxAge(payload, now),
    });
  }
  return res;
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return new NextResponse('SESSION_SECRET is not set', { status: 500 });
  if (req.nextUrl.pathname === '/platform' || req.nextUrl.pathname.startsWith('/platform/')) {
    return platformProxy(req, secret);
  }

  const now = nowSeconds();
  const v = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, secret, now);
  if (!v.ok) return toLogin(req, v.reason === 'invalid' ? 'signin' : 'expired');

  let payload = v.payload;
  let newRefresh: string | undefined;

  if (payload.src === 'cognito' && now - payload.ref > COGNITO_REFRESH_AFTER_S) {
    const cfg = cognitoConfig();
    const refresh = req.cookies.get(REFRESH_COOKIE)?.value;
    if (!cfg || !refresh) return toLogin(req, 'expired');
    try {
      const tokens = await refreshTokens(cfg, refresh);
      await verifyIdToken(cfg, tokens.idToken);
      newRefresh = tokens.refreshToken;
      payload = { ...payload, ref: now };
    } catch {
      return toLogin(req, 'expired');
    }
  }

  const res = NextResponse.next();
  if (now - payload.seen > TOUCH_AFTER_S || payload !== v.payload) {
    payload = { ...payload, seen: now };
    res.cookies.set(SESSION_COOKIE, await signSession(payload, secret), {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: sessionMaxAge(payload, now),
    });
  }
  if (newRefresh) {
    res.cookies.set(REFRESH_COOKIE, newRefresh, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: sessionMaxAge(payload, now),
    });
  }
  return res;
}

export const config = {
  // Everything except public pages, auth routes, the PWA files and static assets.
  matcher: [
    '/((?!login|dev-login|offline|auth/|manifest.webmanifest|sw.js|icons/|icon|apple-icon|favicon|_next/).*)',
  ],
};
