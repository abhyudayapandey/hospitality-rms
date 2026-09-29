'use server';

import { notFound, redirect } from 'next/navigation';
import { DEV_USERS } from '@outlet-ops/db/dev-users';
import { setSessionCookie } from '@/lib/auth/server';
import { newSession } from '@/lib/auth/session';
import { sql, withUser } from '@/lib/db';
import { isDevAuthEnabled } from '@/lib/dev-auth';
import { field } from '@/lib/form';

// DEV ONLY (ADR 004). Unreachable in production builds.
export async function devLogin(form: FormData): Promise<void> {
  if (!isDevAuthEnabled()) notFound();
  const uid = field(form, 'uid');
  if (!DEV_USERS.some((u) => u.id === uid)) notFound();
  const active = await withUser(uid, async (tx) => {
    const r = await sql<{ id: string }>`select id from core.me()`.execute(tx);
    return r.rows.length === 1;
  });
  if (!active) redirect('/login?reason=unknown_user');
  await setSessionCookie(newSession(uid, 'dev'));
  redirect('/');
}
