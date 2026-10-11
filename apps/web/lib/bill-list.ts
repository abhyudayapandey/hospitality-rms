import 'server-only';
import { sql, type Tx } from './db';
import type { DateRange } from './date-range';
import { inDays } from './list-days';

// Vendor bills (BIL-3, ADR 050, 120): the bills at stores, by tab and optionally on chosen days
// (their bill dates), and the orders received with no bill yet (released in the last 60 days,
// or on the chosen days). The screen and its download read them here.

export const BILL_TABS = ['all', 'goods', 'services', 'waiting'] as const;
export type BillTab = (typeof BILL_TABS)[number];

export interface BillRow {
  id: string;
  kind: 'goods' | 'service';
  supplier: string | null;
  bill_no: string | null;
  bill_date: Date;
  /** the bill's date as written, for the download */
  bill_day: string;
  amount: string;
  description: string | null;
  store_id: string;
  store: string;
}

export interface WaitingRow {
  id: string;
  supplier: string | null;
  store_id: string;
  store: string;
  /** what was received and what it cost (the receipts), never the order's estimate */
  received: string;
  released_at: Date | null;
}

export async function billList(
  tx: Tx,
  o: { nodes: string[]; node: string; tab: BillTab; limit: number; range: DateRange | null },
) {
  const where = sql`b.delivery_node_id = any(${o.nodes}::uuid[]) and b.archived_at is null
    and (${o.tab} not in ('goods', 'services')
         or b.kind = case ${o.tab} when 'goods' then 'goods' else 'service' end)
    and (${o.range === null} or b.bill_date between ${o.range?.from ?? null}::date
                                                and ${o.range?.to ?? null}::date)`;
  const b = await sql<BillRow>`
    select b.id, b.kind, coalesce(s.name, b.supplier_name) as supplier, b.bill_no, b.bill_date,
           b.bill_date::text as bill_day,
           b.amount, b.description, b.delivery_node_id::text as store_id,
           core.node_name(b.delivery_node_id) as store
      from inv.bill b
      left join inv.supplier s on s.id = b.supplier_id
     where ${where}
     order by b.bill_date desc, b.created_at desc
     limit ${o.limit}`.execute(tx);
  const w = await sql<WaitingRow>`
    select po.id, s.name as supplier, po.delivery_node_id::text as store_id,
           core.node_name(po.delivery_node_id) as store,
           inv.po_received_value(po.id) as received, po.released_at
      from inv.purchase_order_summary po
      left join inv.supplier s on s.id = po.supplier_id
     where po.delivery_node_id = any(${o.nodes}::uuid[])
       and po.received_qty > 0
       and (case when ${o.range === null} then po.released_at > now() - interval '60 days'
                 else ${inDays(sql.ref('po.released_at'), o.node, o.range)} end)
       and not exists (select 1 from inv.bill b where b.po_id = po.id and b.archived_at is null)
     order by po.released_at desc
     limit ${o.limit}`.execute(tx);
  // the count and the total of every bill in the tab, not only those shown (ADR 053)
  const t = await sql<{ n: number; total: string | null }>`
    select count(*)::int as n, sum(b.amount) as total from inv.bill b where ${where}`.execute(tx);
  return {
    bills: b.rows,
    waiting: w.rows,
    count: t.rows[0]?.n ?? 0,
    sum: Number(t.rows[0]?.total ?? 0),
  };
}
