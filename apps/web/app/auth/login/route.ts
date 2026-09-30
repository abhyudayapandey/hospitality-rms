import { NextResponse } from 'next/server';
import { appUrl } from '@/lib/app-url';
import { authorizeUrl, cognitoConfig } from '@/lib/auth/cognito';
import { PKCE_COOKIE, pkceChallenge, randomToken } from '@/lib/auth/session';
import { clientAddress, LIMITS, withinLimit } from '@/lib/security/rate-limit';

// Starts the Cognito Hosted UI sign-in (authorization code + PKCE).
export async function GET(req: Request) {
  const cfg = cognitoConfig();
  if (!cfg) return NextResponse.redirect(appUrl('/login?reason=cognito'));
  if (!(await withinLimit(`signin:${clientAddress(req.headers)}`, LIMITS.signIn))) {
    return NextResponse.redirect(appUrl('/login?reason=rate_limited'));
  }
  const state = randomToken(16);
  const verifier = randomToken(32);
  const res = NextResponse.redirect(authorizeUrl(cfg, state, await pkceChallenge(verifier)));
  res.cookies.set(PKCE_COOKIE, `${state}.${verifier}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/auth',
    maxAge: 600,
  });
  return res;
}
