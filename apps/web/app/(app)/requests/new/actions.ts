'use server';

import { notFound, redirect } from 'next/navigation';
import { failure } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { isDevAuthEnabled } from '@/lib/dev-auth';
import { field } from '@/lib/form';

// DEV ONLY (ADR 004): submits a workflow request with a generated subject id so the
// inbox can be exercised before subject tables exist. Remove in the inventory prompt.

export interface TestRequestState {
  error?: string;
}

export async function submitTestRequest(
  _prev: TestRequestState,
  form: FormData,
): Promise<TestRequestState> {
  if (!isDevAuthEnabled()) notFound();
  const user = await requireUser();
  const processType = field(form, 'process');
  const nodeId = field(form, 'node');
  const amountRaw = field(form, 'amount').trim();
  const amount = amountRaw === '' ? null : Number(amountRaw);
  const idempotencyKey = field(form, 'idempotencyKey') || null;
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
    return { error: 'Enter a valid amount.' };
  }
  let id: string;
  try {
    id = await withUser(user.id, async (tx) => {
      const p = await sql<{ subject_type: string; hierarchy_type: string }>`
        select subject_type, hierarchy_type from wf.my_processes() where process_type = ${processType}`.execute(
        tx,
      );
      const proc = p.rows[0];
      if (!proc) throw new Error('UNKNOWN_PROCESS');
      const n = await sql<{
        type: string;
      }>`select type from core.nodes() where id = ${nodeId}::uuid`.execute(tx);
      if (n.rows[0]?.type !== proc.hierarchy_type) throw new Error('INVALID_SUBJECT');
      const org = proc.hierarchy_type === 'org' ? nodeId : null;
      const delivery = proc.hierarchy_type === 'delivery' ? nodeId : null;
      const r = await sql<{ id: string }>`
        select wf.submit(${processType}, ${proc.subject_type}, core.uuid_v7(), ${JSON.stringify({ test: true })}::jsonb,
                         ${amount}, 'INR', ${org}::uuid, ${delivery}::uuid, ${idempotencyKey}) as id`.execute(
        tx,
      );
      return r.rows[0]!.id;
    });
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('wf.submit failed', err);
    return { error: f.message };
  }
  redirect(`/requests?created=${id}`);
}
