import 'server-only';
import { sql, withUser, type Tx } from './db';
import type { ExpiryBatch } from './expiry';
import type { SearchParams } from './params';
import { pickPlace, screenPlaces, type Place, type Screen } from './places';
import { loadShell, type Shell } from './shell';

// Reads for the supply screens. Every query runs inside withUser, so RLS decides what is
// visible; access here only chooses what to show (ADR 004). Every list is filtered by one
// delivery node (ADR 007: node-filtered reads stay well under 200 ms).

export { isUuid, param, type SearchParams } from './params';
export { formatQty, inputQty } from './qty';

export interface SupplyContext {
  shell: Shell;
  screen: SupplyScreen;
  /** the stock locations this screen can show (core.screen_places), most useful first */
  nodes: Place[];
  node: Place | null;
  can(domain: string, access?: 'view' | 'modify'): boolean;
}

export type SupplyScreen = Extract<
  Screen,
  | 'stock'
  | 'count'
  | 'check'
  | 'wastage'
  | 'orders'
  | 'transfers'
  | 'bills'
  | 'production'
  | 'variance'
>;

/**
 * The stock location a supply screen works on (ADR 016): ?node= when the screen offers it,
 * else the person's last choice on this screen, else the most useful one.
 */
export async function supplyContext(
  sp: SearchParams,
  screen: SupplyScreen,
): Promise<SupplyContext> {
  const shell = await loadShell();
  const nodes = await withUser(shell.user.id, (tx) => screenPlaces(tx, screen, shell));
  const node = await pickPlace(screen, nodes, sp);
  return {
    shell,
    screen,
    nodes,
    node,
    can(domain, access = 'view') {
      const a = shell.domains.get(domain);
      return a !== undefined && (access === 'view' || a === 'modify');
    },
  };
}

export interface StockRow {
  item_id: string;
  sku: string;
  name: string;
  category: string;
  base_uom: string;
  par_level: string;
  on_hand: string;
  avg_cost: string | null;
  value: string | null;
  below_par: boolean;
  /** what went out over the last 14 days (lib/low-stock.ts) */
  used: string | null;
  /** the item's photo in the photo bucket (ADR 034) */
  photo_key: string | null;
}

/** Dated batches expired or expiring within 3 days, at the stores the person sees stock
 * levels at (INV-12; inv.expiry_list checks). */
export async function expiryList(tx: Tx): Promise<ExpiryBatch[]> {
  const r = await sql<ExpiryBatch>`
    select store_id::text, store, item_id::text, sku, name, unit, batch_no,
           expires_at::text, remaining::text, expired
      from inv.expiry_list(3)`.execute(tx);
  return r.rows;
}

export async function stockList(tx: Tx, node: string): Promise<StockRow[]> {
  const r = await sql<StockRow>`
    select i.id as item_id, i.sku, i.name, i.category, i.base_uom, n.par_level, i.photo_key,
           coalesce(s.on_hand, 0) as on_hand, s.avg_cost, s.value,
           coalesce(s.on_hand, 0) < n.par_level as below_par, u.used
      from inv.item_node n
      join inv.item i on i.id = n.item_id
      left join inv.stock_level s on s.item_id = n.item_id and s.delivery_node_id = n.delivery_node_id
      left join lateral (
        select -sum(l.qty) as used from inv.stock_ledger l
         where l.item_id = n.item_id and l.delivery_node_id = n.delivery_node_id
           and l.qty < 0 and l.movement_type <> 'count_adjust'
           and l.occurred_at > now() - interval '14 days') u on true
     where n.delivery_node_id = ${node}::uuid and n.archived_at is null and i.archived_at is null
     order by i.category, i.name`.execute(tx);
  return r.rows;
}

export interface StockRowAll extends StockRow {
  store_id: string;
  store: string;
}

/** Every item at each of the stores `nodes` (the person's stock places), naming its store:
 * "All stores" on the Stock screen (ADR 038, 048). */
export async function stockListAll(
  tx: Tx,
  places: readonly { id: string; name: string }[],
): Promise<StockRowAll[]> {
  if (places.length === 0) return [];
  const nodes = places.map((p) => p.id);
  const names = new Map(places.map((p) => [p.id, p.name]));
  const r = await sql<StockRowAll>`
    select i.id as item_id, i.sku, i.name, i.category, i.base_uom, n.par_level, i.photo_key,
           n.delivery_node_id::text as store_id,
           coalesce(s.on_hand, 0) as on_hand, s.avg_cost, s.value,
           coalesce(s.on_hand, 0) < n.par_level as below_par, u.used
      from inv.item_node n
      join inv.item i on i.id = n.item_id
      left join inv.stock_level s on s.item_id = n.item_id and s.delivery_node_id = n.delivery_node_id
      left join lateral (
        select -sum(l.qty) as used from inv.stock_ledger l
         where l.item_id = n.item_id and l.delivery_node_id = n.delivery_node_id
           and l.qty < 0 and l.movement_type <> 'count_adjust'
           and l.occurred_at > now() - interval '14 days') u on true
     where n.delivery_node_id = any(${nodes}::uuid[])
       and n.archived_at is null and i.archived_at is null
     order by i.category, i.name, n.delivery_node_id`.execute(tx);
  return r.rows.map((x) => ({ ...x, store: names.get(x.store_id) ?? '' }));
}

export interface LedgerRow {
  id: string;
  occurred_at: Date;
  movement_type: string;
  qty: string;
  unit_cost: string;
  reason: string | null;
  ref_type: string;
  item_name: string;
  base_uom: string;
}

export async function ledger(tx: Tx, node: string, item?: string): Promise<LedgerRow[]> {
  const r = await sql<LedgerRow>`
    select l.id, l.occurred_at, l.movement_type, l.qty, l.unit_cost, l.reason, l.ref_type,
           i.name as item_name, i.base_uom
      from inv.stock_ledger l
      join inv.item i on i.id = l.item_id
     where l.delivery_node_id = ${node}::uuid
       and (${item ?? null}::uuid is null or l.item_id = ${item ?? null}::uuid)
     order by l.occurred_at desc
     limit 50`.execute(tx);
  return r.rows;
}

export interface ItemOption {
  item_id: string;
  name: string;
  base_uom: string;
  on_hand: string;
  avg_cost: string;
  /** Kitchen & Bar or Housekeeping, where the list is grouped (ADR 051 addendum) */
  item_group?: string | null;
}

/** Items set up at the node, for pickers. */
export async function itemOptions(tx: Tx, node: string): Promise<ItemOption[]> {
  const r = await sql<ItemOption>`
    select i.id as item_id, i.name, i.base_uom, coalesce(s.on_hand, 0) as on_hand,
           coalesce(s.avg_cost, 0) as avg_cost
      from inv.item_node n
      join inv.item i on i.id = n.item_id
      left join inv.stock_level s on s.item_id = n.item_id and s.delivery_node_id = n.delivery_node_id
     where n.delivery_node_id = ${node}::uuid and n.archived_at is null and i.archived_at is null
     order by i.name`.execute(tx);
  return r.rows;
}

export const WASTAGE_REASONS = [
  ['spoiled', 'Spoiled'],
  ['expired', 'Expired'],
  ['prep_error', 'Prep error'],
  ['damaged', 'Damaged'],
  ['other', 'Other'],
] as const;

export function movementLabel(type: string, reason: string | null): string {
  const base: Record<string, string> = {
    receipt: 'Received',
    consumption: 'Used',
    wastage: 'Wastage',
    transfer_out: 'Sent',
    transfer_in: 'Transfer in',
    count_adjust: 'Count adjustment',
  };
  const r = reason && reason !== 'opening balance' ? ` · ${reason.replace(/_/g, ' ')}` : '';
  return `${base[type] ?? type}${r}`;
}

/** Purchase order progress (inv.purchase_order_summary.progress): label and badge style. */
export const PO_PROGRESS: Record<string, [string, string]> = {
  awaiting_approval: ['waiting for approval', 'bg-amber-100 text-amber-900'],
  to_order: ['to be ordered', 'bg-amber-100 text-amber-900'],
  released: ['ordered', 'bg-sky-100 text-sky-900'],
  partially_received: ['part received', 'bg-sky-100 text-sky-900'],
  received: ['received', 'bg-emerald-100 text-emerald-900'],
  rejected: ['rejected', 'bg-rose-100 text-rose-900'],
  cancelled: ['cancelled', 'bg-slate-200 text-slate-700'],
  // the rest is not coming, or the request was withdrawn (ADR 052)
  closed: ['closed', 'bg-slate-200 text-slate-700'],
  withdrawn: ['withdrawn', 'bg-slate-200 text-slate-700'],
};

/**
 * A department's view of an order its Main Store places and receives (ADR 052): where it is,
 * in the department's words, never what it costs.
 */
export const SUPPLY_PROGRESS: Record<string, [string, string]> = {
  ...PO_PROGRESS,
  released: ['on the way', 'bg-sky-100 text-sky-900'],
  partially_received: ['part arrived', 'bg-sky-100 text-sky-900'],
  received: ['arrived', 'bg-emerald-100 text-emerald-900'],
};

/** Transfer progress (inv.transfer_summary.progress): label and badge style. */
export const TRANSFER_PROGRESS: Record<string, [string, string]> = {
  awaiting_approval: ['waiting for approval', 'bg-violet-100 text-violet-900'],
  awaiting_dispatch: ['waiting to be sent', 'bg-amber-100 text-amber-900'],
  in_transit: ['in transit', 'bg-sky-100 text-sky-900'],
  received: ['received', 'bg-emerald-100 text-emerald-900'],
  completed: ['received', 'bg-emerald-100 text-emerald-900'],
  rejected: ['rejected', 'bg-rose-100 text-rose-900'],
  cancelled: ['cancelled', 'bg-slate-200 text-slate-700'],
};

export interface DeskOrder {
  po_id: string;
  store_id: string;
  store: string;
  requested_by: string | null;
  requested_at: Date;
  supplier: string | null;
  expected_on: Date | null;
  stage: 'to_order' | 'to_receive';
  items: string | null;
  unusual: boolean;
}

/** What the order desk (the Main Store's keeper) has to do: requests to order, orders to
 * receive (ADR 049). Empty for anyone who is not the desk of some store. */
export async function deskOrders(tx: Tx): Promise<DeskOrder[]> {
  const r = await sql<DeskOrder>`select * from inv.desk_orders()`.execute(tx);
  return r.rows;
}
