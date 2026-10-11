'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';
import { requireModule } from '@/lib/modules-server';

/** What goes with a status (ADR 117): a time; a reason, a day it is back, a request. */
export interface RoomStatusDetails {
  time?: string;
  reason?: string;
  until?: string;
  maintenance?: string;
  raise?: boolean;
}

// A room's status (ADR 088, 117): ops.set_room_status checks ROOMS modify at the room's outlet
// and raises stable codes (rule 2).
export async function setRoomStatus(
  room: string,
  status: string,
  details: RoomStatusDetails = {},
): Promise<ActionResult<null>> {
  const user = await requireUser();
  try {
    await withUser(user.id, async (tx) => {
      await requireModule(tx, 'rooms');
      await sql`select ops.set_room_status(${room}::uuid, ${status},
                                           ${JSON.stringify(details)}::jsonb)`.execute(tx);
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

/** The open maintenance requests at a room's outlet, to tag it out of order with (ADR 117). */
export async function roomMaintenanceOpen(
  room: string,
): Promise<ActionResult<{ id: string; title: string }[]>> {
  const user = await requireUser();
  try {
    const rows = await withUser(user.id, async (tx) => {
      await requireModule(tx, 'rooms');
      return (
        await sql<{ id: string; title: string }>`
          select id::text, title from ops.room_maintenance_open(${room}::uuid)`.execute(tx)
      ).rows;
    });
    return { ok: true, data: rows };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('room_maintenance_open failed', err);
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

/**
 * A meal's rooms for a mode (ADR 121): each room's guests, 0 taking it off. The outlet's
 * service team sets them; ops.set_meal_rooms checks who and when.
 */
export async function setMealRooms(
  outlet: string,
  day: string,
  meal: string,
  mode: string,
  rooms: { room_id: string; guests: number; note: string }[],
): Promise<ActionResult<number>> {
  return roomsAction('set_meal_rooms', async (tx) => {
    const r = await sql<{ n: number }>`
      select ops.set_meal_rooms(${outlet}::uuid, ${day}::date, ${meal}, ${mode},
                                ${JSON.stringify(rooms)}::jsonb) as n`.execute(tx);
    return r.rows[0]!.n;
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
