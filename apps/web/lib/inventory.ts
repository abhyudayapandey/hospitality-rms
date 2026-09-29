import 'server-only';
import { loadShell, type NodeRow, type Shell } from './shell';
import { sql, type Tx } from './db';

// Reads for the supply screens. Every query runs inside withUser, so RLS decides what is
// visible; access here only chooses what to show (ADR 004). Every list is filtered by one
// delivery node (ADR 007: node-filtered reads stay well under 200 ms).

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export function param(sp: Record<string, string | string[] | undefined>, key: string): string {
  const v = sp[key];
  return typeof v === 'string' ? v : '';
}

export interface SupplyContext {
  shell: Shell;
  /** delivery nodes the user can see, own first, then derived (view-only) */
  nodes: NodeRow[];
  node: NodeRow | null;
  can(domain: string, access?: 'view' | 'modify'): boolean;
}

/**
 * The delivery node the supply screens work on: ?node=, else the current node when it
 * is a delivery node, else the first delivery node the user holds (own before derived).
 */
export async function supplyContext(sp: SearchParams): Promise<SupplyContext> {
  const shell = await loadShell();
  const wanted = param(await sp, 'node');
  const nodes = shell.nodes
    .filter((n) => n.type === 'delivery')
    .sort((a, b) => Number(a.derived) - Number(b.derived));
  const node =
    nodes.find((n) => n.id === wanted) ??
    nodes.find((n) => n.id === shell.currentNode?.id) ??
    nodes.find((n) => !n.derived && n.kind !== 'network') ??
    nodes[0] ??
    null;
  return {
    shell,
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
}

export async function stockList(tx: Tx, node: string): Promise<StockRow[]> {
  const r = await sql<StockRow>`
    select i.id as item_id, i.sku, i.name, i.category, i.base_uom, n.par_level,
           coalesce(s.on_hand, 0) as on_hand, s.avg_cost, s.value,
           coalesce(s.on_hand, 0) < n.par_level as below_par
      from inv.item_node n
      join inv.item i on i.id = n.item_id
      left join inv.stock_level s on s.item_id = n.item_id and s.delivery_node_id = n.delivery_node_id
     where n.delivery_node_id = ${node}::uuid and n.archived_at is null and i.archived_at is null
     order by i.category, i.name`.execute(tx);
  return r.rows;
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

export function formatQty(qty: string | number, uom: string): string {
  const n = Number(qty);
  const text = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(n);
  return `${text} ${uom}`;
}

/** Purchase order progress (inv.purchase_order_summary.progress): label and badge style. */
export const PO_PROGRESS: Record<string, [string, string]> = {
  awaiting_approval: ['awaiting approval', 'bg-amber-100 text-amber-900'],
  released: ['ordered', 'bg-sky-100 text-sky-900'],
  partially_received: ['part received', 'bg-sky-100 text-sky-900'],
  received: ['received', 'bg-emerald-100 text-emerald-900'],
  rejected: ['rejected', 'bg-rose-100 text-rose-900'],
  cancelled: ['cancelled', 'bg-slate-200 text-slate-700'],
};

/** Transfer progress (inv.transfer_summary.progress): label and badge style. */
export const TRANSFER_PROGRESS: Record<string, [string, string]> = {
  awaiting_dispatch: ['awaiting dispatch', 'bg-amber-100 text-amber-900'],
  in_transit: ['in transit', 'bg-sky-100 text-sky-900'],
  received: ['received', 'bg-emerald-100 text-emerald-900'],
  completed: ['received', 'bg-emerald-100 text-emerald-900'],
  rejected: ['rejected', 'bg-rose-100 text-rose-900'],
  cancelled: ['cancelled', 'bg-slate-200 text-slate-700'],
};
