import type { ClientBase } from 'pg';
import { PROCESS_DEFS } from './processes';
import { processDefSchema, type ProcessDef } from './types';

/** Validates the code definitions and upserts them into wf.process_def (as migrator). */
export async function syncProcessDefs(
  client: ClientBase,
  defs: readonly ProcessDef[] = PROCESS_DEFS,
): Promise<number> {
  for (const def of defs) {
    const parsed = processDefSchema.parse(def);
    await client.query('select wf.upsert_process_def($1::jsonb)', [JSON.stringify(parsed)]);
  }
  return defs.length;
}
