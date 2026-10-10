import 'server-only';
import { sql, type Tx } from './db';

// The rooms' minibars (ADR 072): read through ops.* SECURITY DEFINER functions, which check
// MINIBAR at the outlet (rule 2).

export type MinibarTab = 'rooms' | 'charge' | 'usage';
export const MINIBAR_TABS: readonly MinibarTab[] = ['rooms', 'charge', 'usage'];
export const isMinibarTab = (s: string): s is MinibarTab =>
  (MINIBAR_TABS as readonly string[]).includes(s);

export interface MinibarPlace {
  outlet_id: string;
  outlet: string;
  rooms: number;
  can_check: boolean;
  /** they bill these minibars: the front desk and the managers (ADR 104) */
  bills: boolean;
}

export interface MinibarRoomRow {
  id: string;
  number: string;
  floor: string | null;
  room_type: string | null;
  set_name: string | null;
  last_checked_at: Date | null;
  last_checked_by: string | null;
  last_used: number | null;
  checked_today: boolean;
  to_charge: string;
  /** the room's status code (never shown, ADR 104) */
  status: string;
  /** a minibar, not checked today, a guest in, arriving or leaving */
  due_today: boolean;
}

export interface MinibarItem {
  room_id: string;
  number: string;
  outlet_id: string;
  store: string;
  can_check: boolean;
  item_id: string;
  item: string;
  unit: string;
  par: string;
  price: string;
  in_store: string;
}

export interface UsedLine {
  item: string;
  qty: string;
  price?: string;
}

export interface MinibarCheckRow {
  id: string;
  checked_at: Date;
  checked_by: string | null;
  used: UsedLine[];
  charge: string;
  short: boolean;
  charged_at: Date | null;
  charged_by: string | null;
}

export interface ToChargeRow {
  id: string;
  room: string;
  checked_at: Date;
  checked_by: string | null;
  used: UsedLine[];
  charge: string;
}

export interface UsageRow {
  item_id: string;
  item: string;
  unit: string;
  used: string;
  revenue: string;
  cost: string;
  refilled: string;
  rooms: number;
}

export async function minibarPlaces(tx: Tx): Promise<MinibarPlace[]> {
  return (await sql<MinibarPlace>`select * from ops.minibar_places()`.execute(tx)).rows;
}

export async function minibarRooms(tx: Tx, outlet: string): Promise<MinibarRoomRow[]> {
  return (await sql<MinibarRoomRow>`select * from ops.minibar_rooms(${outlet}::uuid)`.execute(tx))
    .rows;
}

export async function minibarRoom(tx: Tx, room: string): Promise<MinibarItem[]> {
  return (await sql<MinibarItem>`select * from ops.minibar_room(${room}::uuid)`.execute(tx)).rows;
}

export async function minibarHistory(tx: Tx, room: string): Promise<MinibarCheckRow[]> {
  return (await sql<MinibarCheckRow>`select * from ops.minibar_history(${room}::uuid)`.execute(tx))
    .rows;
}

export async function minibarToCharge(tx: Tx, outlet: string): Promise<ToChargeRow[]> {
  return (await sql<ToChargeRow>`select * from ops.minibar_to_charge(${outlet}::uuid)`.execute(tx))
    .rows;
}

export async function minibarUsage(
  tx: Tx,
  outlet: string,
  from: string,
  to: string,
): Promise<UsageRow[]> {
  return (
    await sql<UsageRow>`
      select * from ops.minibar_usage(${outlet}::uuid, ${from}::date, ${to}::date)`.execute(tx)
  ).rows;
}

/** "Beer ×1, Tonic ×2" */
export function usedWords(used: readonly UsedLine[]): string {
  return used.map((u) => `${u.item} ×${Number(u.qty)}`).join(', ');
}
