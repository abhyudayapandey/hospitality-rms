import 'server-only';
import { sql, type Tx } from './db';

/**
 * Where RFMs's Request tab goes (ADR 149): the ask form for whoever has a store to ask (their
 * team's, else their outlet's for a team with none, inv.my_ask_stores); Request from a store for
 * a manager who may request for a store; else no Request tab at all.
 */
export async function rfmRequestHref(tx: Tx): Promise<string | null> {
  const r = await sql<{ ask: boolean; request: boolean }>`
    select exists (select 1 from inv.my_ask_stores()) as ask,
           exists (select 1 from core.screen_places('transfers') p
                    where p.type = 'delivery'
                      and core.can('TRANSFERS', 'modify', null, p.id)) as request`.execute(tx);
  const row = r.rows[0];
  return row?.ask ? '/requests?tab=ask' : row?.request ? '/stock/transfers/new' : null;
}
