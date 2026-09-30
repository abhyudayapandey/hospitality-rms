'use server';

import { notFound, redirect } from 'next/navigation';
import { DEV_USERS, devUserKey } from '@outlet-ops/db/dev-users';
import { setSessionCookie } from '@/lib/auth/server';
import { newSession } from '@/lib/auth/session';
import { userIdForUsername } from '@/lib/db';
import { isDevAuthEnabled } from '@/lib/dev-auth';
import { field } from '@/lib/form';

// DEV ONLY (ADR 004). Unreachable in production builds.
export async function devLogin(form: FormData): Promise<void> {
  if (!isDevAuthEnabled()) notFound();
  const key = field(form, 'user');
  const user = DEV_USERS.find((u) => devUserKey(u) === key);
  if (!user) notFound();
  const uid = await userIdForUsername(user.customer, user.username);
  if (!uid) redirect('/login?reason=unknown_user');
  await setSessionCookie(newSession(uid, 'dev'));
  redirect('/');
}
