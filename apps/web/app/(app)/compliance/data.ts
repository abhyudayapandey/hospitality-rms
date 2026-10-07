import 'server-only';
import { sql, type Tx } from '@/lib/db';
import { jobRolesAt } from '@/lib/tasks';

// What the compliance forms offer (ADR 069): the job roles held at each place (a reminder goes
// to one), and whether the person keeps the register there.

export async function rolesByPlace(
  tx: Tx,
  places: readonly string[],
): Promise<Record<string, { code: string; name: string }[]>> {
  const out: Record<string, { code: string; name: string }[]> = {};
  for (const p of places) out[p] = await jobRolesAt(tx, p);
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
