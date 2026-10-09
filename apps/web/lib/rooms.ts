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
