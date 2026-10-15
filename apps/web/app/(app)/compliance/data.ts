import 'server-only';
import { sql, type Tx } from '@/lib/db';
import { jobRolesAt } from '@/lib/tasks';

// What the compliance forms offer (ADR 069): the job roles held at each place (a reminder goes
// to one), and whether the person keeps the register there.

export interface ComplianceRole {
  code: string;
  name: string;
  /** runs the outlet or a department (ADR 151): may renew a licence or answer for a job */
  answers: boolean;
}

/** The duties of those who run something: they renew licences and answer for jobs (ADR 151). */
const RUNS = [
  'RUNS_OUTLET',
  'RUNS_DEPARTMENT',
  'RUNS_CENTRAL_KITCHEN',
  'RUNS_OUTLET_HR',
  'KEEPS_COMPLIANCE',
];

export async function rolesByPlace(
  tx: Tx,
  places: readonly string[],
): Promise<Record<string, ComplianceRole[]>> {
  const running = new Set(
    (
      await sql<{ code: string }>`
        select distinct job_role_code as code from hr.job_role_access
         where duty_code = any(${RUNS}::text[])`.execute(tx)
    ).rows.map((r) => r.code),
  );
  const out: Record<string, ComplianceRole[]> = {};
  for (const p of places) {
    out[p] = (await jobRolesAt(tx, p)).map((r) => ({ ...r, answers: running.has(r.code) }));
  }
  return out;
}

export async function keeps(tx: Tx, node: string): Promise<boolean> {
  const r = await sql<{ v: boolean }>`
    select core.can('COMPLIANCE', 'modify', ${node}::uuid, null) as v`.execute(tx);
  return r.rows[0]?.v ?? false;
}

/** The places someone may add a licence or a job at: where they keep the register. */
export async function keptPlaces<P extends { id: string }>(tx: Tx, places: P[]): Promise<P[]> {
  const out: P[] = [];
  for (const p of places) if (await keeps(tx, p.id)) out.push(p);
  return out;
}
