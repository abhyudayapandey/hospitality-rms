import 'server-only';
import { sql, type Tx } from './db';
import type { DateRange } from './date-range';
import { inDays } from './list-days';

// The Transfers list (ADR 048, 052, 053, 120): what went between a store (or all of the
// person's stores) and the others, by tab, optionally on chosen days. The screen and its
// download read it here.

export interface TransferRow {
  id: string;
  from_node_id: string;
  to_node_id: string;
  from_name: string;
  to_name: string;
  progress: string;
  kind: string;
  created_at: Date;
  items: string | null;
}

export async function transferList(
  tx: Tx,
  o: { nodes: string[]; node: string; tab: 'all' | 'send'; limit: number; range: DateRange | null },
): Promise<{ rows: TransferRow[]; toSend: number }> {
  const scope = sql`(from_node_id = any(${o.nodes}::uuid[]) or to_node_id = any(${o.nodes}::uuid[]))
                    and ${inDays(sql.ref('created_at'), o.node, o.range)}`;
  // waiting to be sent from these stores: what the To send tab lists
  const sending = sql`(progress = 'awaiting_dispatch' and from_node_id = any(${o.nodes}::uuid[]))`;
  const r = await sql<TransferRow>`
    select t.id, t.from_node_id, t.to_node_id, t.from_name, t.to_name, t.progress, t.kind,
           t.created_at,
           -- what is in it (ADR 053)
           (select string_agg(i.name, ', ' order by i.name)
              from inv.transfer_line l join inv.item i on i.id = l.item_id
             where l.transfer_id = t.id) as items
      from inv.transfer_summary t
     where ${scope} and (${o.tab === 'send'} = false or ${sending})
     order by created_at desc limit ${o.limit + 1}`.execute(tx);
  // counted in SQL with no limit, with the To send tab's own filter (ADR 052)
  const toSend = await sql<{ n: number }>`
    select count(*)::int as n from inv.transfer_summary where ${scope} and ${sending}`.execute(tx);
  return { rows: r.rows, toSend: toSend.rows[0]?.n ?? 0 };
}
