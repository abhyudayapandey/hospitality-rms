import { NextResponse } from 'next/server';
import { appUrl } from '@/lib/app-url';
import { authorizeUrl } from '@/lib/auth/cognito';
import { pkceChallenge, randomToken } from '@/lib/auth/session';
import { PLATFORM_PKCE_COOKIE, platformCognitoConfig } from '@/lib/platform/session';
import { clientAddress, LIMITS, withinLimit } from '@/lib/security/rate-limit';

// Starts the platform pool's hosted sign-in (code + PKCE; MFA is required by the pool).
export async function GET(req: Request) {
  const cfg = platformCognitoConfig();
  if (!cfg) return NextResponse.redirect(appUrl('/platform/signin?reason=cognito'));
  if (!(await withinLimit(`platform-signin:${clientAddress(req.headers)}`, LIMITS.signIn))) {
    return NextResponse.redirect(appUrl('/platform/signin?reason=rate_limited'));
  }
  const state = randomToken(16);
  const verifier = randomToken(32);
  const res = NextResponse.redirect(authorizeUrl(cfg, state, await pkceChallenge(verifier)));
  res.cookies.set(PLATFORM_PKCE_COOKIE, `${state}.${verifier}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', // the redirect back from Cognito is a cross-site top-level GET
    path: '/platform/auth',
    maxAge: 600,
  });
  return res;
}
