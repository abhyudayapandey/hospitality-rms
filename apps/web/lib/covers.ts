import 'server-only';
import { sql, type Tx } from './db';

// Covers and spend per cover (ADR 096): ops.covers_day checks that the person opens the
// outlet's day (rpt.can_open('outlet_flash')) and that Menu and sales is on.

export type CoverPeriod = 'breakfast' | 'lunch' | 'dinner';

export interface CoversRow {
  period: CoverPeriod;
  covers: number | null;
  total_covers: number | null;
  sales: string;
  per_cover: string | null;
}

export async function salesOn(tx: Tx): Promise<boolean> {
  const r = await sql<{
    on: boolean;
  }>`select coalesce((select "on" from core.my_modules() where code = 'menu_sales'), false) as on`.execute(
    tx,
  );
  return r.rows[0]?.on ?? false;
}

export async function coversDay(tx: Tx, outlet: string, day: string): Promise<CoversRow[]> {
  return (
    await sql<CoversRow>`
      select period, covers, total_covers, sales::text, per_cover::text
        from ops.covers_day(${outlet}::uuid, ${day}::date)`.execute(tx)
  ).rows;
}
