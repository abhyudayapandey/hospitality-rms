import 'server-only';
import type { ModuleCode } from '@outlet-ops/domain';
import { sql, type Tx } from './db';

/**
 * Refuses a write to a switched-off module with MODULE_OFF (core.require_module, ADR 026).
 * Called first in the module's server actions, in the same transaction as the write.
 */
export async function requireModule(tx: Tx, code: ModuleCode): Promise<void> {
  await sql`select core.require_module(${code})`.execute(tx);
}
