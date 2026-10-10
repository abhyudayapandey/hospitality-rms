import 'server-only';
import { sql, type Tx } from './db';

// Excise (ADR 096): read through inv.* SECURITY DEFINER functions, which check EXCISE at the
// store (rule 2). Worked out from the stock ledger.

export interface ExciseStore {
  store_id: string;
  name: string;
  can_edit: boolean;
  today: string;
}

export interface ExciseLine {
  item_id: string;
  item: string;
  unit: string;
  opening: string;
  received: string;
  sold: string;
  sent: string;
  used: string;
  wasted: string;
  adjusted: string;
  closing: string;
}

export interface ExcisePermit {
  id: string;
  permit_no: string;
  received_on: string;
  note: string | null;
  added_by: string | null;
}

export async function exciseStores(tx: Tx): Promise<ExciseStore[]> {
  return (
    await sql<ExciseStore>`
      select store_id::text, name, can_edit, today::text from inv.excise_stores()`.execute(tx)
  ).rows;
}

const cols = sql`item_id::text, item, unit, opening::text, received::text, sold::text,
                 sent::text, used::text, wasted::text, adjusted::text, closing::text`;

export async function exciseRegister(tx: Tx, store: string, day: string): Promise<ExciseLine[]> {
  return (
    await sql<ExciseLine>`select ${cols} from inv.excise_register(${store}::uuid, ${day}::date)`.execute(
      tx,
    )
  ).rows;
}

export async function exciseMonth(tx: Tx, store: string, month: string): Promise<ExciseLine[]> {
  return (
    await sql<ExciseLine>`select ${cols} from inv.excise_month(${store}::uuid, ${month}::date)`.execute(
      tx,
    )
  ).rows;
}

export async function excisePermits(tx: Tx, store: string): Promise<ExcisePermit[]> {
  return (
    await sql<ExcisePermit>`
      select id::text, permit_no, received_on::text, note, added_by
        from inv.excise_permits(${store}::uuid)`.execute(tx)
  ).rows;
}
