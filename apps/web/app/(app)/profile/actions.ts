'use server';

import { after } from 'next/server';
import { InvalidPasswordException } from '@aws-sdk/client-cognito-identity-provider';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { cognitoConfig, logoutUrl } from '@/lib/auth/cognito';
import { loginDirectory } from '@/lib/auth/directory';
import { passwordProblems } from '@/lib/auth/passwords';
import { clearAuthCookies, requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { LIMITS, withinLimit } from '@/lib/security/rate-limit';
import { requireSameOrigin } from '@/lib/security/same-origin';

// The profile's own login actions (ADR 018). Both act only on the signed-in person: the
// database functions take no user. The database records the action; Cognito is the
// other half. Passwords are never stored or logged.

const fail = (code: string) => failure(new Error(code));

async function record(userId: string, ok: boolean): Promise<void> {
  await withUser(userId, (tx) => sql`select core.record_own_password_change(${ok})`.execute(tx));
}

export async function changeOwnPassword(input: {
  current: string;
  next: string;
  confirm: string;
}): Promise<ActionResult> {
  try {
    await requireSameOrigin();
  } catch (err) {
    return failure(err);
  }
  const me = await requireUser();
  // never someone else's login while showing the app as them (ADR 071)
  if (me.presentedBy) return fail('PRESENTING');
  if (input.next !== input.confirm) return fail('PASSWORDS_DIFFER');
  if (passwordProblems(input.next).length) return fail('PASSWORD_POLICY');
  if (!(await withinLimit(`pwchange:${me.id}`, LIMITS.passwordChange))) {
    return fail('RATE_LIMITED');
  }
  const profile = await withUser(me.id, async (tx) => {
    const r = await sql<{ username: string | null; login_type: string }>`
      select username, login_type from core.my_profile()`.execute(tx);
    return r.rows[0];
  });
  if (!profile?.username || profile.login_type !== 'username') return fail('INVALID_ACTION');
  try {
    const r = await loginDirectory().changeOwnPassword(profile.username, input.current, input.next);
    await record(me.id, r === 'ok');
    return r === 'ok' ? { ok: true, data: undefined } : fail('WRONG_PASSWORD');
  } catch (err) {
    if (err instanceof InvalidPasswordException) {
      await record(me.id, false);
      return fail('PASSWORD_POLICY');
    }
    console.error('cognito password change failed', (err as Error).name);
    return fail('UNEXPECTED');
  }
}

/**
 * Ends every session: the database first (every app session is refused from now, this one
 * too), then Cognito revokes every refresh token. Returns where the browser goes next.
 */
export async function signOutEverywhere(): Promise<ActionResult<string>> {
  try {
    await requireSameOrigin();
  } catch (err) {
    return failure(err);
  }
  const me = await requireUser();
  if (me.presentedBy) return fail('PRESENTING');
  let login: string | null;
  try {
    login = await withUser(me.id, async (tx) => {
      const r = await sql<{ username: string | null; email: string | null }>`
        select username, email from core.sign_out_everywhere()`.execute(tx);
      return r.rows[0]?.username ?? r.rows[0]?.email ?? null;
    });
  } catch (err) {
    return failure(err);
  }
  if (login) {
    // the sessions here are already revoked; Cognito's own sign-out follows the answer
    // (ADR 056), so the phone does not wait on it
    const who = login;
    after(() =>
      loginDirectory()
        .signOutEverywhere(who)
        .catch((err: unknown) =>
          console.error('cognito global sign-out failed', (err as Error).name),
        ),
    );
  }
  await clearAuthCookies();
  const cfg = cognitoConfig();
  return {
    ok: true,
    data: me.source === 'cognito' && cfg ? logoutUrl(cfg) : '/login?reason=signed_out_everywhere',
  };
}
