'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';
import { requireModule } from '@/lib/modules-server';

// Registers (ADR 090). Each write is one ops.* SECURITY DEFINER function, which checks who
// keeps the register at the place and raises stable codes (rule 2).

async function run<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, async (tx) => {
      await requireModule(tx, 'registers');
      return fn(tx);
    });
    revalidatePath('/registers');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, err);
    return f;
  }
}

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
