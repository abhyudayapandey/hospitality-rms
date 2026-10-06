import 'server-only';
import {
  customerBundle,
  newCustomerFrom,
  type CreatePayload,
} from '@outlet-ops/onboarding/templates';
import { uploadStore } from '@outlet-ops/onboarding/upload';
import { sql, type Tx } from '@/lib/db';

/**
 * A customer's complete current set of onboarding files (ADR 062): the last import that was
 * applied, or what the customer was created with. Null when neither is known.
 */
export async function currentFiles(
  tx: Tx,
  tenantId: string,
): Promise<Record<string, string> | null> {
  const row = (
    await sql<{ upload_key: string | null; created_with: CreatePayload | null }>`
      select * from platform.current_files(${tenantId}::uuid)`.execute(tx)
  ).rows[0];
  if (row?.upload_key) return (await uploadStore().get(row.upload_key)).files;
  if (row?.created_with) return customerBundle(newCustomerFrom(row.created_with));
  return null;
}
