import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { errorCodeOf } from '@outlet-ops/domain';
import {
  MAX_UPLOAD_BYTES,
  photosToStore,
  readUpload,
  UploadError,
  uploadKey,
  uploadStore,
} from '@outlet-ops/onboarding/upload';
import { appUrl } from '@/lib/app-url';
import { sql, withPlatformAdmin } from '@/lib/db';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { requireSameOrigin } from '@/lib/security/same-origin';

// Uploading a customer's onboarding files (ADR 013): a plain multipart form post, so it
// works without JavaScript. The request must come from the console (same origin) with a
// platform session; its size is checked before it is read. The files are checked (only
// the numbered onboarding files and the dishes' photos (ADR 078), sizes, paths, file 00
// names this customer), stored under
// onboarding/<customer>/, and a dry run is queued. The browser then follows the job.

const back = (tenantId: string, code: string) =>
  NextResponse.redirect(appUrl(`/platform/customers/${tenantId}/import?error=${code}`), 303);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireSameOrigin();
  } catch {
    return new NextResponse('refused', { status: 403 });
  }
  const admin = await requirePlatformAdmin();
  const { id: tenantId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(tenantId)) return new NextResponse('not found', { status: 404 });

  // multipart overhead on top of the files themselves
  const length = Number(req.headers.get('content-length') ?? NaN);
  if (!Number.isFinite(length) || length > MAX_UPLOAD_BYTES + 64 * 1024) {
    return back(tenantId, 'UPLOAD_TOO_LARGE');
  }

  try {
    const customer = await withPlatformAdmin(admin, async (tx) => {
      const r = await sql<{ code: string }>`
        select code from platform.customer(${tenantId}::uuid)`.execute(tx);
      return r.rows[0];
    });
    if (!customer) return new NextResponse('not found', { status: 404 });

    const form = await req.formData();
    const uploads = form.getAll('files').filter((f): f is File => typeof f !== 'string');
    const parts = await Promise.all(
      uploads.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
    );
    const { files, customerCode, photos } = readUpload(parts);
    if (customerCode !== customer.code) return back(tenantId, 'CUSTOMER_MISMATCH');

    const hash = createHash('sha256');
    for (const p of parts) hash.update(p.bytes);
    const key = uploadKey(tenantId, randomUUID());
    await uploadStore().put(key, { files, photos: photosToStore(photos) });
    const upload = {
      key,
      name: parts.length === 1 ? parts[0]!.name : `${parts.length} files`,
      bytes: parts.reduce((n, p) => n + p.bytes.length, 0),
      sha256: hash.digest('hex'),
      files: Object.keys(files),
      customer_code: customerCode,
    };
    const job = await withPlatformAdmin(admin, async (tx) => {
      const r = await sql<{ id: string }>`
        select platform.request_import(${tenantId}::uuid, ${JSON.stringify(upload)}::jsonb) as id`.execute(
        tx,
      );
      return r.rows[0]!.id;
    });
    return NextResponse.redirect(appUrl(`/platform/jobs/${job}`), 303);
  } catch (err) {
    if (err instanceof UploadError) return back(tenantId, err.code);
    const code = errorCodeOf(err);
    if (code === 'UNEXPECTED') console.error('upload failed', (err as Error).name);
    return back(tenantId, code);
  }
}
