'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';
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

async function roomsAction<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, async (tx) => {
      await requireModule(tx, 'rooms');
      return fn(tx);
    });
    revalidatePath('/rooms');
    revalidatePath('/breakfast');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, err);
    return f;
  }
}

/** A room's count (ADR 094): what is there of each thing it should hold. Returns lines short. */
export async function countRoom(
  room: string,
  lines: { item_id: string; counted: number }[],
): Promise<ActionResult<{ short: number }>> {
  return roomsAction('count_room', async (tx) => {
    const r = await sql<{ n: number }>`
      select ops.count_room(${room}::uuid, ${JSON.stringify(lines)}::jsonb) as n`.execute(tx);
    return { short: r.rows[0]!.n };
  });
}

/** The day's breakfast total for a mode (front office, ADR 094). */
export async function setBreakfastTotal(
  outlet: string,
  day: string,
  mode: string,
  guests: number,
): Promise<ActionResult<null>> {
  return roomsAction('set_breakfast_total', async (tx) => {
    await sql`select ops.set_breakfast_total(${outlet}::uuid, ${day}::date, ${mode}, ${guests})`.execute(
      tx,
    );
    return null;
  });
}

/** A room's breakfast that day: how many and how; 0 takes it off the list. */
export async function setBreakfastRoom(
  room: string,
  day: string,
  mode: string,
  guests: number,
  note: string,
): Promise<ActionResult<null>> {
  return roomsAction('set_breakfast_room', async (tx) => {
    await sql`select ops.set_breakfast_room(${room}::uuid, ${day}::date, ${mode}, ${guests},
                                            ${note})`.execute(tx);
    return null;
  });
}

/**
 * Give rooms for a day (ADR 111): the person gets exactly these rooms; rooms another had move
 * to them. ops.give_rooms checks who may (ROOMS modify and TASKS modify over housekeeping).
 */
export async function giveRooms(
  outlet: string,
  day: string,
  person: string,
  roomIds: string[],
): Promise<ActionResult<number>> {
  return roomsAction('give_rooms', async (tx) => {
    const r = await sql<{ n: number }>`
      select ops.give_rooms(${outlet}::uuid, ${day}::date, ${person}::uuid,
                            ${roomIds}::uuid[]) as n`.execute(tx);
    return r.rows[0]!.n;
  });
}
