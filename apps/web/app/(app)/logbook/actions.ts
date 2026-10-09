'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';
import { requireModule } from '@/lib/modules-server';

// Logbook & handover (ADR 089). Each write is one ops.* SECURITY DEFINER function, which
// checks LOGBOOK at the place or the handover's To do item, and raises stable codes (rule 2).

async function run<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, async (tx) => {
      await requireModule(tx, 'logbook');
      return fn(tx);
    });
    revalidatePath('/logbook');
    revalidatePath('/tasks', 'layout');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, err);
    return f;
  }
}

export type HandoverTo =
  { mode: 'on_shift' } | { mode: 'job_role'; role: string } | { mode: 'person'; user_id: string };

export async function writeLog(input: {
  place: string;
  kind: 'handover' | 'log';
  body: string;
  toPlace: string | null;
  to: HandoverTo | null;
  validTill: string | null;
  idempotencyKey: string;
}): Promise<ActionResult<{ id: string }>> {
  return run('write_log', async (tx) => {
    const r = await sql<{ id: string }>`
      select ops.write_log(${input.place}::uuid, ${input.kind}, ${input.body},
                           ${input.toPlace}::uuid, ${input.to ? JSON.stringify(input.to) : null}::jsonb,
                           ${input.validTill}::timestamptz, ${input.idempotencyKey}) as id`.execute(
      tx,
    );
    return { id: r.rows[0]!.id };
  });
}

export async function acknowledgeHandover(task: string): Promise<ActionResult<null>> {
  return run('acknowledge_handover', async (tx) => {
    await sql`select ops.acknowledge_handover(${task}::uuid)`.execute(tx);
    return null;
  });
}

export async function takeDownLog(entry: string): Promise<ActionResult<null>> {
  return run('take_down_log', async (tx) => {
    await sql`select ops.take_down_log(${entry}::uuid)`.execute(tx);
    return null;
  });
}
