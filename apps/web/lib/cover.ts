import 'server-only';
import type { CoverAnswer } from '@outlet-ops/domain';
import { sql, type Tx } from '@/lib/db';

// Admin → Who does what (ADR 065): what core.admin_role_cover returns, and the outlets the
// admin may look at.

export interface CoverRow {
  outlet_id: string;
  outlet_name: string;
  job_role_code: string;
  role_name: string;
  duties: string[];
  duty_names: string[];
  people: number;
  answer: CoverAnswer;
  covered_by_role: string | null;
  covered_by_name: string | null;
  changed_by: string | null;
  changed_at: Date | null;
  can_change: boolean;
}

export interface CoverOutlet {
  outlet_id: string;
  outlet_name: string;
  covers: number;
  can_change: boolean;
}

export async function coverOutlets(tx: Tx): Promise<CoverOutlet[]> {
  return (await sql<CoverOutlet>`select * from core.admin_cover_outlets()`.execute(tx)).rows;
}

/** Every role at one outlet, or (null) only the covers across the admin's outlets. */
export async function coverRows(tx: Tx, outlet: string | null): Promise<CoverRow[]> {
  return (await sql<CoverRow>`select * from core.admin_role_cover(${outlet}::uuid)`.execute(tx))
    .rows;
}
