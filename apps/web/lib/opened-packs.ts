import 'server-only';
import type { Allergen } from '@outlet-ops/domain';
import { sql, type Tx } from './db';

// Opened packs (Shelf life & labels, ADR 093): read through inv.* SECURITY DEFINER functions, which check
// SHELF_LIFE at the store (rule 2).

export interface OpenPack {
  id: string;
  item_id: string;
  name: string;
  unit: string;
  qty: string;
  opened_at: string;
  use_by: string;
  opened_by: string | null;
  expired: boolean;
}

export interface PackLabel {
  id: string;
  name: string;
  qty: string;
  unit: string;
  food_type: 'veg' | 'non_veg' | 'egg' | null;
  allergens: Allergen[];
  storage: 'dry' | 'chilled' | 'frozen' | null;
  opened_at: string;
  use_by: string;
  opened_by: string | null;
  store: string;
  tz: string;
  status: 'open' | 'used' | 'thrown';
}

export interface PackItem {
  item_id: string;
  name: string;
  base_uom: string;
  hours: number;
  on_hand: string;
}

export async function openPacks(tx: Tx, store: string): Promise<OpenPack[]> {
  const r = await sql<OpenPack>`
    select id::text, item_id::text, name, unit, qty::text, opened_at::text, use_by::text,
           opened_by, expired
      from inv.open_packs(${store}::uuid)`.execute(tx);
  return r.rows;
}

export async function packLabel(tx: Tx, pack: string): Promise<PackLabel | null> {
  const r = await sql<PackLabel>`
    select id::text, name, qty::text, unit, food_type, allergens, storage, opened_at::text,
           use_by::text, opened_by, store, tz, status
      from inv.pack_label(${pack}::uuid)`.execute(tx);
  return r.rows[0] ?? null;
}

/** What may be opened at a store: items kept there with a shelf life once opened. */
export async function packItems(tx: Tx, store: string): Promise<PackItem[]> {
  const r = await sql<PackItem>`
    select i.id::text as item_id, i.name, i.base_uom, i.open_shelf_life_hours as hours,
           coalesce(s.on_hand, 0)::text as on_hand
      from inv.item_node x
      join inv.item i on i.id = x.item_id
      left join inv.stock_level s on s.item_id = x.item_id and s.delivery_node_id = x.delivery_node_id
     where x.delivery_node_id = ${store}::uuid and x.archived_at is null
       and i.archived_at is null and i.open_shelf_life_hours is not null
     order by i.name`.execute(tx);
  return r.rows;
}
