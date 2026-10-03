import 'server-only';
import { sql, type Tx } from './db';
import { readSettings, type CompanySettings } from './settings';

/** The company's settings (anyone signed in may read them), with the defaults filled in. */
export async function companySettings(tx: Tx): Promise<CompanySettings> {
  const r = await sql<{ s: unknown }>`select core.company_settings() as s`.execute(tx);
  return readSettings(r.rows[0]?.s);
}
