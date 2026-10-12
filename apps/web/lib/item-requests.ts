import 'server-only';
import { sql, type Tx } from './db';

// An item's open requests at a store (its item page): stock asked of another store and supplies
// asked to be bought, still on their way. Read under the person's own access.

export interface ItemRequest {
  kind: 'stock' | 'supply';
  id: string;
  progress: string;
  created_at: Date;
  qty: string;
  /** where it comes from: the store asked, or the supplier */
  source: string | null;
}

export async function itemRequests(tx: Tx, node: string, item: string): Promise<ItemRequest[]> {
  return (
    await sql<ItemRequest>`
      select 'stock' as kind, t.id::text, t.progress, t.created_at,
             sum(l.requested_qty)::text as qty, t.from_name as source
        from inv.transfer_summary t
        join inv.transfer_line l on l.transfer_id = t.id and l.item_id = ${item}::uuid
       where t.to_node_id = ${node}::uuid
         and t.progress in ('awaiting_approval', 'awaiting_dispatch', 'in_transit')
       group by t.id, t.progress, t.created_at, t.from_name
      union all
      select 'supply', po.id::text, po.progress, po.created_at,
             sum(pl.qty)::text, s.name
        from inv.purchase_order_summary po
        join inv.purchase_order_line pl on pl.po_id = po.id and pl.item_id = ${item}::uuid
        left join inv.supplier s on s.id = po.supplier_id
       where po.delivery_node_id = ${node}::uuid
         and po.progress not in ('received', 'closed', 'rejected', 'cancelled', 'withdrawn')
       group by po.id, po.progress, po.created_at, s.name
       order by created_at desc
       limit 10`.execute(tx)
  ).rows;
}
