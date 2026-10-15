import 'server-only';
import { cookies } from 'next/headers';
import { sql, userIdForCognitoSub, withUser } from '../db';
import { verifyIdToken, type CognitoConfig, type TokenSet } from './cognito';
import { setSessionCookie } from './server';
import { ABSOLUTE_TIMEOUT_S, REFRESH_COOKIE, newSession } from './session';

/**
 * Starts the app's session from Cognito's tokens, the same for our own sign-in screen and
 * the Hosted UI callback (ADR 161): verify the ID token, find the app user for its sub,
 * record the sign-in, set the session and refresh cookies. 'unknown_user' when the login
 * has no person in the app.
 */
export async function startSession(
  cfg: CognitoConfig,
  tokens: TokenSet,
): Promise<'ok' | 'unknown_user'> {
  const sub = await verifyIdToken(cfg, tokens.idToken);
  const uid = await userIdForCognitoSub(sub);
  if (!uid) return 'unknown_user';
  await withUser(uid, (tx) => sql`select core.record_sign_in()`.execute(tx));
  await setSessionCookie(newSession(uid, 'cognito'));
  if (tokens.refreshToken) {
    (await cookies()).set(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: ABSOLUTE_TIMEOUT_S,
    });
  }
  return 'ok';
}
