import 'server-only';
import { sql, type Tx } from './db';
import { titleOf, type TitleOf } from './job-roles';

/** The customer's job titles, as a function from code to title (lib/job-roles.ts). */
export async function jobTitles(tx: Tx): Promise<TitleOf> {
  const r = await sql<{ code: string; name: string }>`select code, name from hr.job_role`.execute(
    tx,
  );
  return titleOf(new Map(r.rows.map((x) => [x.code, x.name])));
}
