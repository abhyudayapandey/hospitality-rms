import 'server-only';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  BILL_TYPES,
  MAX_BILL_BYTES,
  MAX_PHOTO_BYTES,
  URL_TTL_SECONDS,
  type BillFileType,
  type PhotoPrefix,
  type PhotoType,
  type UploadTarget,
  viewWindowStart,
} from './photo-policy';

// Photos on this machine's disk (PHOTO_DIR) where there is no bucket: local development and the
// e2e run, so every step's photo (ADR 127) can be taken there too. The same rules as the bucket:
// a fixed key, its type, 5 minutes, at most 5 MB (10 for a bill), signed with SESSION_SECRET.
// Never used where PHOTO_BUCKET is set (every deployed server).

export function localPhotoDir(): string | null {
  if (process.env.PHOTO_BUCKET) return null;
  return process.env.PHOTO_DIR || null;
}

function sign(parts: string[]): string {
  return createHmac('sha256', process.env.SESSION_SECRET ?? '')
    .update(parts.join('\n'))
    .digest('hex');
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function fileOf(key: string): string {
  const dir = resolve(localPhotoDir() ?? '');
  const path = resolve(join(dir, key));
  if (!localPhotoDir() || !path.startsWith(dir + '/') || key.includes('..')) {
    throw new Error('INVALID_PHOTO');
  }
  return path;
}

export function presignLocalUpload(
  prefix: PhotoPrefix,
  tenantId: string,
  nodeId: string,
  contentType: PhotoType | BillFileType,
): UploadTarget {
  const documents = prefix === 'bills' || prefix === 'compliance';
  if (contentType === 'application/pdf' && !documents) throw new Error('INVALID_PHOTO');
  const key = `${prefix}/${tenantId}/${nodeId}/${randomUUID()}.${BILL_TYPES[contentType]}`;
  const exp = String(Math.floor(Date.now() / 1000) + URL_TTL_SECONDS);
  const max = String(documents ? MAX_BILL_BYTES : MAX_PHOTO_BYTES);
  const sig = sign(['put', key, contentType, max, exp]);
  return {
    url: '/api/photo-local',
    fields: { key, 'Content-Type': contentType, max, exp, sig },
    key,
  };
}

/** Stores one upload if its fields are the ones signed; false otherwise. */
export async function saveLocalUpload(form: FormData): Promise<boolean> {
  const f = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' ? v : '';
  };
  const [key, type, max, exp, sig] = [f('key'), f('Content-Type'), f('max'), f('exp'), f('sig')];
  const file = form.get('file');
  if (!same(sig, sign(['put', key, type, max, exp]))) return false;
  if (Number(exp) < Date.now() / 1000 || !(file instanceof Blob)) return false;
  if (file.size < 1 || file.size > Number(max)) return false;
  const path = fileOf(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(await file.arrayBuffer()));
  return true;
}

export function presignLocalView(key: string): string {
  // the same link through a 5-minute window, as presignView (ADR 169)
  const exp = String(Math.floor(viewWindowStart().getTime() / 1000) + 2 * URL_TTL_SECONDS);
  const q = new URLSearchParams({ key, exp, sig: sign(['get', key, exp]) });
  return `/api/photo-local?${q}`;
}

/** The stored file, if the link is signed and not expired. */
export async function readLocalPhoto(
  q: URLSearchParams,
): Promise<{ body: Buffer; type: string } | null> {
  const [key, exp, sig] = [q.get('key') ?? '', q.get('exp') ?? '', q.get('sig') ?? ''];
  if (!same(sig, sign(['get', key, exp])) || Number(exp) < Date.now() / 1000) return null;
  try {
    const body = await readFile(fileOf(key));
    const ext = key.split('.').pop() ?? '';
    const type =
      Object.entries(BILL_TYPES).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
    return { body, type };
  } catch {
    return null;
  }
}

export async function copyLocalPhoto(from: string, to: string): Promise<void> {
  const target = fileOf(to);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(fileOf(from), target);
}
