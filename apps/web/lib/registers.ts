import 'server-only';
import { sql, type Tx } from './db';
import type { DateRange } from './date-range';

// Registers (ADR 090): read through ops.* SECURITY DEFINER functions, which check REGISTERS at
// the place and who keeps each register (rule 2).

export interface RegisterPlace {
  place_id: string;
  place: string;
  kind: 'outlet' | 'department';
  outlet: string;
  registers: string[];
  can_write: string[];
}

export interface RegisterEntry {
  id: string;
  fields: Record<string, string>;
  status: 'open' | 'closed';
  outcome: string | null;
  close_note: string | null;
  written_at: Date;
  written_by: string | null;
  closed_at: Date | null;
  closed_by: string | null;
  can_close: boolean;
}

export async function registerPlaces(tx: Tx): Promise<RegisterPlace[]> {
  return (await sql<RegisterPlace>`select * from ops.register_places()`.execute(tx)).rows;
}

export async function registerEntries(
  tx: Tx,
  place: string,
  register: string,
  /** only what was written on these days (ADR 120); else the open ones and the last 30 days */
  range: DateRange | null = null,
): Promise<RegisterEntry[]> {
  if (!range) {
    return (
      await sql<RegisterEntry>`select * from ops.register_entries(${place}::uuid, ${register})`.execute(
        tx,
      )
    ).rows;
  }
  return (
    await sql<RegisterEntry>`
      select e.* from ops.register_entries(${place}::uuid, ${register},
                                           current_date - ${range.from}::date + 2) e
       where rpt.days_window(${place}::uuid, ${range.from}::date, ${range.to}::date)
             @> e.written_at`.execute(tx)
  ).rows;
}
