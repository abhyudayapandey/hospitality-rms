import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { uploadKey, uploadStore } from '@outlet-ops/onboarding/upload';
import { sql, type Tx } from '@/lib/db';

/**
 * Stores a complete set of onboarding files as an upload and requests its dry run (ADR 013):
 * what "Add an outlet" (ADR 062) and the set-up wizard (ADR 064) make goes through the same
 * report and apply as any import. Returns the dry run's job id.
 */
export async function requestDryRun(
  tx: Tx,
  tenantId: string,
  customerCode: string,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const key = uploadKey(tenantId, randomUUID());
  await uploadStore().put(key, { files });
  const hash = createHash('sha256');
  for (const f of Object.keys(files).sort()) hash.update(f).update(files[f]!);
  const upload = {
    key,
    name,
    bytes: Object.values(files).reduce((n, t) => n + Buffer.byteLength(t), 0),
    sha256: hash.digest('hex'),
    files: Object.keys(files),
    customer_code: customerCode.toUpperCase(),
  };
  const r = await sql<{ id: string }>`
    select platform.request_import(${tenantId}::uuid, ${JSON.stringify(upload)}::jsonb) as id`.execute(
    tx,
  );
  return r.rows[0]!.id;
}
