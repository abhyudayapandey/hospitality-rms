'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';
import { requireModule } from '@/lib/modules-server';

// Training & SOPs (ADR 095): each write is one ops.* SECURITY DEFINER function, which checks
// TRAINING at the place, or that the SOP is the person's, and raises stable codes (rule 2).

async function run<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, async (tx) => {
      await requireModule(tx, 'training');
      return fn(tx);
    });
    revalidatePath('/training', 'layout');
    revalidatePath('/me/sops', 'layout');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, err);
    return f;
  }
}

export async function ackSop(id: string): Promise<ActionResult<null>> {
  return run('ack_sop', async (tx) => {
    await sql`select ops.ack_sop(${id}::uuid)`.execute(tx);
    return null;
  });
}

export async function addSession(input: {
  place: string;
  title: string;
  startsAt: string;
  trainer: string;
  isTest: boolean;
}): Promise<ActionResult<{ id: string }>> {
  return run('add_training_session', async (tx) => {
    const r = await sql<{ id: string }>`
      select ops.add_training_session(${input.place}::uuid, ${input.title},
                                      ${input.startsAt}::timestamptz, ${input.trainer},
                                      ${input.isTest}, null) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

export async function markAttendance(
  session: string,
  person: string,
  attended: boolean,
  score: number | null,
): Promise<ActionResult<null>> {
  return run('mark_attendance', async (tx) => {
    await sql`select ops.mark_attendance(${session}::uuid, ${person}::uuid, ${attended},
                                         ${score})`.execute(tx);
    return null;
  });
}
