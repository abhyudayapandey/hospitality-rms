'use server';

import { cookies } from 'next/headers';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { PLACE_COOKIE } from '@/lib/auth/session';
import { SHOW_AS_COOKIE, showAsToken } from '@/lib/auth/show-as';
import { sql, withUser } from '@/lib/db';
import { requireSameOrigin } from '@/lib/security/same-origin';

// Show as someone else, for demos (ADR 071). Both run as the presenter themselves; the
// database checks they are one (core.begin_show_as, core.end_show_as) and the cookie only
// counts once it agrees.

const secure = process.env.NODE_ENV === 'production';
const SHOW_AS_MAX_AGE_S = 12 * 60 * 60;

export async function showAs(target: string): Promise<ActionResult<null>> {
  try {
    await requireSameOrigin();
    const user = await requireUser();
    const presenter = user.presentedBy?.id ?? user.id;
    if (!user.canShowAs) return failure(new Error('NOT_AUTHORISED'));
    // a new one ends the one before (core.begin_show_as)
    await withUser(presenter, (tx) => sql`select core.begin_show_as(${target}::uuid)`.execute(tx));
    const jar = await cookies();
    jar.set(SHOW_AS_COOKIE, await showAsToken(presenter, target), {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: SHOW_AS_MAX_AGE_S,
    });
    // the places chosen on each screen were someone else's
    jar.delete(PLACE_COOKIE);
    return { ok: true, data: null };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('show_as failed', err);
    return f;
  }
}

export async function backToMe(): Promise<ActionResult<null>> {
  try {
    await requireSameOrigin();
    const user = await requireUser();
    const jar = await cookies();
    if (user.presentedBy) {
      await withUser(user.presentedBy.id, (tx) => sql`select core.end_show_as()`.execute(tx));
    }
    jar.delete(SHOW_AS_COOKIE);
    jar.delete(PLACE_COOKIE);
    return { ok: true, data: null };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('back_to_me failed', err);
    return f;
  }
}
