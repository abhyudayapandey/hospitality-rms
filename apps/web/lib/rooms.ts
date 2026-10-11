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
  /** whose the room is today (ADR 111), and whether it is mine */
  given_to: string | null;
  given_to_name: string | null;
  mine: boolean;
}

export async function roomOutlets(tx: Tx): Promise<RoomOutlet[]> {
  return (await sql<RoomOutlet>`select * from ops.room_outlets()`.execute(tx)).rows;
}

export async function rooms(tx: Tx, outlet: string): Promise<RoomRow[]> {
  return (
    await sql<RoomRow>`select *, given_to::text as given_to from ops.rooms(${outlet}::uuid)`.execute(
      tx,
    )
  ).rows;
}

// Rooms given to people for a day (ADR 111)

export interface RoomPerson {
  user_id: string;
  name: string;
  role_name: string;
}

export async function givesRooms(tx: Tx, outlet: string): Promise<boolean> {
  return (await sql<{ v: boolean }>`select ops.gives_rooms(${outlet}::uuid) as v`.execute(tx))
    .rows[0]!.v;
}

export async function roomPeople(tx: Tx, outlet: string): Promise<RoomPerson[]> {
  return (
    await sql<RoomPerson>`
      select user_id::text, name, role_name from ops.room_people(${outlet}::uuid)
       order by name`.execute(tx)
  ).rows;
}

export async function roomAssignments(
  tx: Tx,
  outlet: string,
  day: string,
): Promise<{ room_id: string; user_id: string; name: string }[]> {
  return (
    await sql<{ room_id: string; user_id: string; name: string }>`
      select room_id::text, user_id::text, name
        from ops.room_assignments(${outlet}::uuid, ${day}::date)`.execute(tx)
  ).rows;
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
  /** the breakfast still to come (ADR 110): today's until it ends, then tomorrow's */
  next_day: string;
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
      select outlet_id::text, name, today::text, next_day::text from ops.breakfast_outlets()`.execute(
      tx,
    )
  ).rows;
}

export async function breakfastDay(tx: Tx, outlet: string, day: string): Promise<BreakfastMode[]> {
  return (
    await sql<BreakfastMode>`
      select mode, total, rooms, room_list, can_edit
        from ops.breakfast_day(${outlet}::uuid, ${day}::date)`.execute(tx)
  ).rows;
}
