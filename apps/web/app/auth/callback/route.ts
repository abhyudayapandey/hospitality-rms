import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { appUrl } from '@/lib/app-url';
import { cognitoConfig, exchangeCode } from '@/lib/auth/cognito';
import { PKCE_COOKIE } from '@/lib/auth/session';
import { startSession } from '@/lib/auth/start-session';
import { clientAddress, LIMITS, withinLimit } from '@/lib/security/rate-limit';

// Cognito redirects here with ?code&state. Verify state (PKCE cookie), exchange the code,
// then start the session as our own sign-in screen does (startSession, ADR 161).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const fail = (reason: string) => NextResponse.redirect(appUrl(`/login?reason=${reason}`));
  if (!(await withinLimit(`signin:${clientAddress(req.headers)}`, LIMITS.signIn))) {
    return fail('rate_limited');
  }
  const cfg = cognitoConfig();
  const jar = await cookies();
  const [state, verifier] = (jar.get(PKCE_COOKIE)?.value ?? '').split('.');
  jar.delete(PKCE_COOKIE);
  const code = url.searchParams.get('code');
  if (!cfg || !code || !state || !verifier || url.searchParams.get('state') !== state)
    return fail('cognito');

  try {
    const tokens = await exchangeCode(cfg, code, verifier);
    if ((await startSession(cfg, tokens)) === 'unknown_user') return fail('unknown_user');
  } catch {
    return fail('cognito');
  }
  return NextResponse.redirect(appUrl('/'));
}
