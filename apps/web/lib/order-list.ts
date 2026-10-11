import 'server-only';
import { sql, type Tx } from './db';
import type { DateRange } from './date-range';
import { inDays } from './list-days';

// The Orders list (ADR 048, 049, 052, 120): a store's own orders and the departments' requests
// its keeper orders and receives (the order desk), by tab, optionally on chosen days. The
// screen and its download read it here, so the file is the list.

export const ORDER_TABS = ['all', 'to_order', 'receive', 'received'] as const;
export type OrderTab = (typeof ORDER_TABS)[number];

export interface OrderRow {
  id: string;
  supplier: string | null;
  store_id: string;
  store: string;
  progress: string;
  created_at: Date;
  /** the day it is due (ADR 049) */
  expected_on: string | null;
  items: string | null;
  value: string | null;
  bill_missing: boolean;
  desk: boolean;
  /** a department's order its Main Store places and receives: no ₹, "on the way" (ADR 052) */
  follow: boolean;
}

// which tab a progress belongs to; closed orders (the rest is not coming) are done
const BUCKET = sql`case progress when 'to_order' then 'to_order'
                                 when 'released' then 'receive'
                                 when 'partially_received' then 'receive'
                                 when 'received' then 'received'
                                 when 'closed' then 'received'
                                 else 'other' end`;

export async function orderList(
  tx: Tx,
  o: { nodes: string[]; node: string; tab: OrderTab; limit: number; range: DateRange | null },
): Promise<{ rows: OrderRow[]; counts: Map<string, number> }> {
  // counted with no limit, listed a page at a time (ADR 052)
  const scope = sql`
    with o as (
      select po.id, s.name as supplier, po.delivery_node_id as store_id,
             core.node_name(po.delivery_node_id) as store, po.progress, po.created_at,
             (select string_agg(i.name, ', ' order by i.name)
                from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
               where pl.po_id = po.id) as items,
             false as desk
        from inv.purchase_order_summary po
        left join inv.supplier s on s.id = po.supplier_id
       where po.delivery_node_id = any(${o.nodes}::uuid[])
      union all
      select d.po_id, d.supplier, d.store_id, d.store, d.progress, d.created_at, d.items, true
        from inv.desk_order_list() d
       where not (d.store_id = any(${o.nodes}::uuid[])))
    select *, ${BUCKET} as bucket from o
     where ${inDays(sql.ref('o.created_at'), o.node, o.range)}`;
  const c = await sql<{ bucket: string; n: number }>`
    select bucket, count(*)::int as n from (${scope}) x group by bucket`.execute(tx);
  const r = await sql<OrderRow>`
    select id, supplier, store_id::text, store, progress, created_at, items, desk,
           (select p.expected_on::text from inv.purchase_order p where p.id = x.id)
             as expected_on,
           inv.po_received_value(id) as value,
           coalesce(inv.po_bill_missing(id), false) as bill_missing,
           inv.follows_order(id) as follow
      from (${scope}) x
     where ${o.tab} = 'all' or bucket = ${o.tab}
     order by created_at desc, id
     limit ${o.limit + 1}`.execute(tx);
  return { rows: r.rows, counts: new Map(c.rows.map((x) => [x.bucket, x.n])) };
}
