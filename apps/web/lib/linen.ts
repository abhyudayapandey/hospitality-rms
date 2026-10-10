import 'server-only';
import { sql, type Tx } from './db';

// Linen & uniforms (ADR 094): read through ops.* SECURITY DEFINER functions, which check LINEN
// at the place (rule 2).

export interface LinenPlace {
  place_id: string;
  name: string;
  kind: 'outlet' | 'department';
  can_edit: boolean;
  people: { id: string; name: string }[];
}

export interface LaundryRow {
  day: string;
  item_id: string;
  item: string;
  sent: number;
  received: number;
  at_laundry: number;
}

export interface UniformRow {
  id: string;
  person: string;
  item: string;
  size: string | null;
  qty: number;
  issued_at: string;
  returned_at: string | null;
}

export async function linenPlaces(tx: Tx): Promise<LinenPlace[]> {
  return (
    await sql<LinenPlace>`
      select place_id::text, name, kind, can_edit, people from ops.linen_places()`.execute(tx)
  ).rows;
}

export async function linenItems(
  tx: Tx,
  place: string,
): Promise<{ item_id: string; name: string }[]> {
  return (
    await sql<{ item_id: string; name: string }>`
      select item_id::text, name from ops.linen_items(${place}::uuid)`.execute(tx)
  ).rows;
}

export async function laundry(tx: Tx, place: string): Promise<LaundryRow[]> {
  return (
    await sql<LaundryRow>`
      select day::text, item_id::text, item, sent, received, at_laundry
        from ops.laundry(${place}::uuid)`.execute(tx)
  ).rows;
}

export async function uniforms(tx: Tx, place: string): Promise<UniformRow[]> {
  return (
    await sql<UniformRow>`
      select id::text, person, item, size, qty, issued_at::text, returned_at::text
        from ops.uniforms(${place}::uuid)`.execute(tx)
  ).rows;
}
