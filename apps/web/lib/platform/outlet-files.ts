import 'server-only';
import {
  customerBundle,
  newCustomerFrom,
  withLiveCovers,
  type CoverRow,
  type CreatePayload,
} from '@outlet-ops/onboarding/templates';
import { uploadStore } from '@outlet-ops/onboarding/upload';
import { sql, type Tx } from '@/lib/db';

/**
 * A customer's complete current set of onboarding files (ADR 062): the last import that was
 * applied, or what the customer was created with, with file 37 written from the live covers
 * so changes made in Admin → Who does what are kept (ADR 065). Null when neither is known.
 */
export async function currentFiles(
  tx: Tx,
  tenantId: string,
): Promise<Record<string, string> | null> {
  const row = (
    await sql<{ upload_key: string | null; created_with: CreatePayload | null }>`
      select * from platform.current_files(${tenantId}::uuid)`.execute(tx)
  ).rows[0];
  const files = row?.upload_key
    ? (await uploadStore().get(row.upload_key)).files
    : row?.created_with
      ? customerBundle(newCustomerFrom(row.created_with))
      : null;
  if (!files) return null;
  const covers = await sql<CoverRow>`
    select * from platform.role_cover_rows(${tenantId}::uuid)`.execute(tx);
  return withLiveCovers(files, covers.rows);
}
