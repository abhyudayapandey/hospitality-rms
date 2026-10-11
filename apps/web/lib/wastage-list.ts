import 'server-only';
import { sql, type Tx } from './db';
import type { DateRange } from './date-range';
import { inDays } from './list-days';

// A store's wastage (ADR 120): the latest lines, or every line on the chosen days. The screen
// and its download read it here.

export interface WastageRow {
  id: string;
  item_id: string;
  name: string;
  base_uom: string;
  qty: string;
  reason: string;
  value: string;
  outcome: string;
  created_at: Date;
}

export async function wastageList(
  tx: Tx,
  node: string,
  range: DateRange | null,
  limit: number,
): Promise<WastageRow[]> {
  const r = await sql<WastageRow>`
    select wl.id, wl.item_id::text, i.name, i.base_uom, wl.qty, wl.reason, wl.value, wl.outcome,
           wl.created_at
      from inv.wastage_line wl join inv.item i on i.id = wl.item_id
     where wl.delivery_node_id = ${node}::uuid
       and ${inDays(sql.ref('wl.created_at'), node, range)}
     order by wl.created_at desc limit ${limit}`.execute(tx);
  return r.rows;
}
