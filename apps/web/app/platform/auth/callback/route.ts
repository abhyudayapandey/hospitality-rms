import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { exchangeCode, verifyIdTokenClaims } from '@/lib/auth/cognito';
import { sessionSecret } from '@/lib/auth/server';
import { platformSignIn } from '@/lib/db';
import {
  isPlatformAdmin,
  newPlatformSession,
  PLATFORM_COOKIE,
  PLATFORM_PKCE_COOKIE,
  platformCognitoConfig,
  platformCookie,
  platformMaxAge,
  signPlatformSession,
} from '@/lib/platform/session';
import { clientAddress, LIMITS, withinLimit } from '@/lib/security/rate-limit';

// The platform pool returns here. Verify state, exchange the code, verify the ID token,
// and admit only members of platform-admins (ADR 012); then start a platform session.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/platform/signin?reason=${reason}`, req.url));
  if (!(await withinLimit(`platform-signin:${clientAddress(req.headers)}`, LIMITS.signIn))) {
    return fail('rate_limited');
  }
  const cfg = platformCognitoConfig();
  const jar = await cookies();
  const [state, verifier] = (jar.get(PLATFORM_PKCE_COOKIE)?.value ?? '').split('.');
  jar.delete({ name: PLATFORM_PKCE_COOKIE, path: '/platform/auth' });
  const code = url.searchParams.get('code');
  if (!cfg || !code || !state || !verifier || url.searchParams.get('state') !== state) {
    return fail('cognito');
  }
  let claims;
  try {
    const tokens = await exchangeCode(cfg, code, verifier);
    claims = await verifyIdTokenClaims(cfg, tokens.idToken);
  } catch {
    return fail('cognito');
  }
  if (!isPlatformAdmin(claims)) return fail('not_platform_admin');
  let adminId: string;
  try {
    adminId = await platformSignIn(claims.sub, claims.email);
  } catch {
    return fail('not_platform_admin');
  }
  const session = newPlatformSession(adminId);
  jar.set(PLATFORM_COOKIE, await signPlatformSession(session, sessionSecret()), {
    ...platformCookie,
    maxAge: platformMaxAge(session),
  });
  return NextResponse.redirect(new URL('/platform', req.url));
}
