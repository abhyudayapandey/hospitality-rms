import 'server-only';
import { sql, type Tx } from './db';
import { askedRange, type DateRange } from './date-range';
import { param, type SearchParams } from './params';

// A list's days in its SQL (ADR 120): the business days chosen, at the list's place, as one
// `where` clause; no days chosen keeps every row.

/** A where-clause keeping the rows whose `col` falls in the days at `node`; true when none. */
export function inDays(col: ReturnType<typeof sql.ref>, node: string, r: DateRange | null) {
  return r
    ? sql<boolean>`rpt.days_window(${node}::uuid, ${r.from}::date, ${r.to}::date) @> ${col}`
    : sql<boolean>`true`;
}

/** The days a list was asked for (?from=&to=) at a place, or null for all of it. */
export async function listDays(
  tx: Tx,
  sp: Awaited<SearchParams> | URLSearchParams,
  node: string,
): Promise<{ range: DateRange | null; today: string }> {
  const get = (k: string) =>
    (sp instanceof URLSearchParams ? sp.get(k) : param(sp, k)) || undefined;
  const today = (await sql<{ d: string }>`select rpt.today(${node}::uuid)::text as d`.execute(tx))
    .rows[0]!.d;
  return { range: askedRange({ from: get('from'), to: get('to') }, today), today };
}
