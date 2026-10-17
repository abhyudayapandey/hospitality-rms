'use server';

import { type ActionResult } from '@outlet-ops/domain';
import { sql, type Tx } from '@/lib/db';
import { runAction } from '@/lib/run-action';

// Linen & uniforms (ADR 094): each write is one ops.* SECURITY DEFINER function, which checks
// LINEN at the place and raises stable codes (rule 2).

const run = <T>(label: string, fn: (tx: Tx) => Promise<T>) =>
  runAction(label, fn, { module: 'linen', revalidate: ['/linen'] });

export async function recordLaundry(
  place: string,
  day: string,
  lines: { item_id: string; sent: number; received: number }[],
): Promise<ActionResult<null>> {
  return run('record_laundry', async (tx) => {
    await sql`select ops.record_laundry(${place}::uuid, ${day}::date,
                                        ${JSON.stringify(lines)}::jsonb)`.execute(tx);
    return null;
  });
}

export async function issueUniform(input: {
  place: string;
  person: string;
  item: string;
  size: string;
  qty: number;
}): Promise<ActionResult<{ id: string }>> {
  return run('issue_uniform', async (tx) => {
    const r = await sql<{ id: string }>`
      select ops.issue_uniform(${input.place}::uuid, ${input.person}::uuid, ${input.item},
                               ${input.size}, ${input.qty}) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

export async function returnUniform(id: string): Promise<ActionResult<null>> {
  return run('return_uniform', async (tx) => {
    await sql`select ops.return_uniform(${id}::uuid)`.execute(tx);
    return null;
  });
}
