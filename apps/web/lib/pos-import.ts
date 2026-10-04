import 'server-only';
import { sql, type Tx } from './db';

// Reads for the POS import (SAL-2, ADR 039) and "Push today" (INV-12, ADR 040). Each is a
// SECURITY DEFINER function that checks access itself; nothing here decides it.

export interface Unmatched {
  code: string;
  description: string;
  qty: number;
  value: number;
}

export interface PosImport {
  id: string;
  file_name: string;
  imported_at: string;
  imported_by: string | null;
  net: string;
  discount: string;
  posted: number;
  unmatched: Unmatched[];
}

/** The day's latest import at an outlet, or null. */
export async function posImportOf(tx: Tx, outlet: string, date: string): Promise<PosImport | null> {
  const r = await sql<PosImport>`
    select id, file_name, imported_at::text, imported_by, net::text, discount::text, posted,
           unmatched
      from menu.pos_import_of(${outlet}::uuid, ${date}::date)`.execute(tx);
  return r.rows[0] ?? null;
}

/** The dishes on the outlet's menu a POS code can be matched to (names only). */
export async function posDishes(
  tx: Tx,
  outlet: string,
): Promise<{ id: string; name: string; group: string }[]> {
  const r = await sql<{ id: string; name: string; group: string }>`
    select menu_item_id as id, name, menu as "group" from menu.pos_dishes(${outlet}::uuid)`.execute(
    tx,
  );
  return r.rows;
}

/** Outlets where the caller imports POS sales. */
export async function posPlaces(tx: Tx): Promise<{ outlet_id: string; outlet_name: string }[]> {
  const r = await sql<{ outlet_id: string; outlet_name: string }>`
    select outlet_id, outlet_name from menu.pos_places()`.execute(tx);
  return r.rows;
}

export interface PushDish {
  outlet_id: string;
  outlet: string;
  menu_item_id: string;
  dish: string;
  menu: string;
  item: string;
  expires_at: string;
}

/** Home's "Push today" at the person's own outlet (service teams and its managers). */
export async function myPushToday(tx: Tx): Promise<PushDish[]> {
  const r = await sql<PushDish>`
    select outlet_id, outlet, menu_item_id, dish, menu, item, expires_at::text
      from menu.my_push_today()`.execute(tx);
  return r.rows;
}
