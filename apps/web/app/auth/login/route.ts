import { NextResponse } from 'next/server';
import { authorizeUrl, cognitoConfig } from '@/lib/auth/cognito';
import { PKCE_COOKIE, pkceChallenge, randomToken } from '@/lib/auth/session';

// Starts the Cognito Hosted UI sign-in (authorization code + PKCE).
export async function GET(req: Request) {
  const cfg = cognitoConfig();
  if (!cfg) return NextResponse.redirect(new URL('/login?reason=cognito', req.url));
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
