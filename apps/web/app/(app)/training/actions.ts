'use server';

import { type ActionResult } from '@outlet-ops/domain';
import { sql, type Tx } from '@/lib/db';
import { runAction } from '@/lib/run-action';

// Training & SOPs (ADR 095): each write is one ops.* SECURITY DEFINER function, which checks
// TRAINING at the place, or that the SOP is the person's, and raises stable codes (rule 2).

const run = <T>(label: string, fn: (tx: Tx) => Promise<T>) =>
  runAction(label, fn, {
    module: 'training',
    revalidate: [
      ['/training', 'layout'],
      ['/me/sops', 'layout'],
    ],
  });

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
