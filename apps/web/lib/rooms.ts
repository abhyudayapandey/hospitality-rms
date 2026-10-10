import 'server-only';
import { sql, type Tx } from './db';

// Rooms and their status (ADR 088): read through ops.* SECURITY DEFINER functions, which check
// ROOMS at the outlet (rule 2).

export interface RoomOutlet {
  outlet_id: string;
  name: string;
  rooms: number;
}

export interface RoomRow {
  room_id: string;
  number: string;
  floor: string | null;
  room_type: string | null;
  status: string;
  status_name: string;
  set_at: Date | null;
  set_by_name: string | null;
  can_set: boolean;
}

export async function roomOutlets(tx: Tx): Promise<RoomOutlet[]> {
  return (await sql<RoomOutlet>`select * from ops.room_outlets()`.execute(tx)).rows;
}

export async function rooms(tx: Tx, outlet: string): Promise<RoomRow[]> {
  return (await sql<RoomRow>`select * from ops.rooms(${outlet}::uuid)`.execute(tx)).rows;
}

// Room contents and breakfast (ADR 094)

export interface RoomContentRow {
  room_id: string;
  number: string;
  floor: string | null;
  room_type: string | null;
  item_id: string;
  item: string;
  unit: string;
  expected: string;
  counted: string | null;
  counted_at: string | null;
  counted_by: string | null;
}

export async function roomContents(tx: Tx, outlet: string): Promise<RoomContentRow[]> {
  return (
    await sql<RoomContentRow>`
      select room_id::text, number, floor, room_type, item_id::text, item, unit,
             expected::text, counted::text, counted_at::text, counted_by
        from ops.room_contents(${outlet}::uuid)`.execute(tx)
  ).rows;
}

export interface BreakfastOutlet {
  outlet_id: string;
  name: string;
  today: string;
}

export interface BreakfastRoom {
  room_id: string;
  number: string;
  guests: number;
  note: string | null;
  by: string | null;
}

export interface BreakfastMode {
  mode: 'in_room' | 'buffet';
  total: number | null;
  rooms: number;
  room_list: BreakfastRoom[];
  can_edit: boolean;
}

export async function breakfastOutlets(tx: Tx): Promise<BreakfastOutlet[]> {
  return (
    await sql<BreakfastOutlet>`
      select outlet_id::text, name, today::text from ops.breakfast_outlets()`.execute(tx)
  ).rows;
}

export async function breakfastDay(tx: Tx, outlet: string, day: string): Promise<BreakfastMode[]> {
  return (
    await sql<BreakfastMode>`
      select mode, total, rooms, room_list, can_edit
        from ops.breakfast_day(${outlet}::uuid, ${day}::date)`.execute(tx)
  ).rows;
}
