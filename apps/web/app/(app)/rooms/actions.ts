'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { requireModule } from '@/lib/modules-server';

// A room's status (ADR 088): ops.set_room_status checks ROOMS modify at the room's outlet and
// raises stable codes (rule 2).
export async function setRoomStatus(room: string, status: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  try {
    await withUser(user.id, async (tx) => {
      await requireModule(tx, 'rooms');
      await sql`select ops.set_room_status(${room}::uuid, ${status})`.execute(tx);
    });
    revalidatePath('/rooms');
    revalidatePath('/tasks', 'layout');
    return { ok: true, data: null };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('set_room_status failed', err);
    return f;
  }
}
