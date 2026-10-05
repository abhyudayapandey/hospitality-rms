'use server';

import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';

/**
 * Approve or reject through wf.act (CLAUDE.md rule 4). wf.act is idempotent by state:
 * repeating an action returns INVALID_STATE ("already actioned"), so the key is accepted
 * for the convention but not stored. The client refreshes after showing the result.
 */
export async function actOnRequest(
  requestId: string,
  action: 'approve' | 'reject',
  _idempotencyKey?: string,
  /** why, kept on the step (a rejected transfer says why, ADR 053) */
  comment?: string,
): Promise<ActionResult<{ state: string }>> {
  const user = await requireUser();
  try {
    const state = await withUser(user.id, async (tx) => {
      const r = await sql<{
        state: string;
      }>`select wf.act(${requestId}::uuid, ${action}, ${comment?.trim() || null}) as state`.execute(
        tx,
      );
      return r.rows[0]!.state;
    });
    return { ok: true, data: { state } };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('wf.act failed', err);
    return f;
  }
}
