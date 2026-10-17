'use server';

import { type ActionResult } from '@outlet-ops/domain';
import { sql, type Tx } from '@/lib/db';
import { runAction } from '@/lib/run-action';

// Registers (ADR 090). Each write is one ops.* SECURITY DEFINER function, which checks who
// keeps the register at the place and raises stable codes (rule 2).

const run = <T>(label: string, fn: (tx: Tx) => Promise<T>) =>
  runAction(label, fn, { module: 'registers', revalidate: ['/registers'] });

export async function addRegisterEntry(input: {
  place: string;
  register: string;
  fields: Record<string, string>;
  idempotencyKey: string;
}): Promise<ActionResult<{ id: string }>> {
  return run('add_register_entry', async (tx) => {
    const r = await sql<{ id: string }>`
      select ops.add_register_entry(${input.place}::uuid, ${input.register},
                                    ${JSON.stringify(input.fields)}::jsonb,
                                    ${input.idempotencyKey}) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

export async function closeRegisterEntry(
  entry: string,
  outcome: string | null,
  note: string | null,
): Promise<ActionResult<null>> {
  return run('close_register_entry', async (tx) => {
    await sql`select ops.close_register_entry(${entry}::uuid, ${outcome}, ${note})`.execute(tx);
    return null;
  });
}
