import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { cognitoConfig, exchangeCode, verifyIdToken } from '@/lib/auth/cognito';
import { setSessionCookie } from '@/lib/auth/server';
import { PKCE_COOKIE, REFRESH_COOKIE, ABSOLUTE_TIMEOUT_S, newSession } from '@/lib/auth/session';
import { userIdForCognitoSub } from '@/lib/db';

// Cognito redirects here with ?code&state. Verify state (PKCE cookie), exchange the code,
// verify the ID token with aws-jwt-verify, map sub -> app user, start the session.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/login?reason=${reason}`, req.url));
  const cfg = cognitoConfig();
  const jar = await cookies();
  const [state, verifier] = (jar.get(PKCE_COOKIE)?.value ?? '').split('.');
  jar.delete(PKCE_COOKIE);
  const code = url.searchParams.get('code');
  if (!cfg || !code || !state || !verifier || url.searchParams.get('state') !== state)
    return fail('cognito');

  let sub: string;
  let refreshToken: string | undefined;
  try {
    const tokens = await exchangeCode(cfg, code, verifier);
    sub = await verifyIdToken(cfg, tokens.idToken);
    refreshToken = tokens.refreshToken;
  } catch {
    return fail('cognito');
  }
  const uid = await userIdForCognitoSub(sub);
  if (!uid) return fail('unknown_user');

  await setSessionCookie(newSession(uid, 'cognito'));
  if (refreshToken) {
    jar.set(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: ABSOLUTE_TIMEOUT_S,
    });
  }
  return NextResponse.redirect(new URL('/', req.url));
}
