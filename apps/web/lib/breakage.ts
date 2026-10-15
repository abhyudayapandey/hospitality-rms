import 'server-only';
import { sql, type Tx } from './db';

// Breakage (ADR 093): read through inv.* SECURITY DEFINER functions, which check BREAKAGE
// (and, for an outlet's whole log, who heads a department there) (rule 2).

export interface BreakagePlace {
  place_id: string;
  name: string;
  kind: 'outlet' | 'department';
  outlet_id: string;
  outlet: string;
  can_record: boolean;
  stores: { id: string; name: string }[];
  people: { id: string; name: string }[];
}

export interface BreakageItem {
  item_id: string;
  name: string;
  unit: string;
  durable: boolean;
  on_hand: string;
}

export interface BreakageEntry {
  id: string;
  broken_at: string;
  place: string;
  store: string;
  item_id: string;
  item: string;
  unit: string;
  qty: string;
  reason: string;
  broken_by: string;
  person: string | null;
  note: string | null;
  /** ₹, only for whoever reads the store's cost (KI-09); else null */
  value: string | null;
  recorded_by: string | null;
  /** the photo of what broke (ADR 143), under wastage/ */
  photo_key: string | null;
}

export interface BreakageMonth {
  month: string;
  entries: number;
  /** ₹ of the entries the reader may see the value of; null when none (KI-09) */
  value: string | null;
}

export async function breakagePlaces(tx: Tx): Promise<BreakagePlace[]> {
  const r = await sql<BreakagePlace>`
    select place_id::text, name, kind, outlet_id::text, outlet, can_record, stores, people
      from inv.breakage_places()`.execute(tx);
  return r.rows;
}

export async function breakageItems(tx: Tx, store: string): Promise<BreakageItem[]> {
  const r = await sql<BreakageItem>`
    select item_id::text, name, unit, durable, on_hand::text
      from inv.breakage_items(${store}::uuid)`.execute(tx);
  return r.rows;
}

export async function breakageLog(tx: Tx, place: string, month: string): Promise<BreakageEntry[]> {
  const r = await sql<BreakageEntry>`
    select id::text, broken_at::text, place, store, item_id::text, item, unit, qty::text, reason,
           broken_by, person, note, value::text, recorded_by, photo_key
      from inv.breakage_log(${place}::uuid, ${month}::date)`.execute(tx);
  return r.rows;
}

export async function breakageMonths(tx: Tx, place: string): Promise<BreakageMonth[]> {
  const r = await sql<BreakageMonth>`
    select month::text, entries, value::text from inv.breakage_months(${place}::uuid)`.execute(tx);
  return r.rows;
}
