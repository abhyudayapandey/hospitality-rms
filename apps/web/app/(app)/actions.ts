'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/server';
import { NODE_COOKIE } from '@/lib/auth/session';
import { sql, withUser } from '@/lib/db';

/** Switches the current node; only nodes from core.nodes() are accepted. */
export async function setCurrentNode(nodeId: string, _idempotencyKey?: string): Promise<void> {
  const user = await requireUser();
  const ok = await withUser(user.id, async (tx) => {
    const r = await sql<{
      id: string;
    }>`select id from core.nodes() where id = ${nodeId}::uuid`.execute(tx);
    return r.rows.length === 1;
  });
  if (!ok) return;
  (await cookies()).set(NODE_COOKIE, nodeId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
  revalidatePath('/', 'layout');
}
