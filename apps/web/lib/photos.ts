import 'server-only';
import { CopyObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  presignUpload,
  presignView,
  type BillFileType,
  type PhotoPrefix,
  type PhotoType,
  type UploadTarget,
} from './photo-policy';
import { copyLocalPhoto, localPhotoDir, presignLocalUpload, presignLocalView } from './photo-local';

// Wastage photos (ADR 006) and task photos (ADR 020): a private S3 bucket (PHOTO_BUCKET), written and read only
// through short-lived presigned URLs issued here with the instance role's credentials.
// Callers check core.can() in SQL before asking for a URL (never in TypeScript).
// Without a bucket, local development and e2e may keep them on disk instead (PHOTO_DIR,
// lib/photo-local.ts), so the live-camera photo every step needs (ADR 127) works there too.

export {
  isBillFileType,
  isPhotoType,
  MAX_BILL_BYTES,
  keptKey,
  MAX_PHOTO_BYTES,
  photoKeyPattern,
  wastageKeyPattern,
  type BillFileType,
  type PhotoPrefix,
  type PhotoType,
  type UploadTarget,
} from './photo-policy';

export function photosEnabled(): boolean {
  return Boolean(process.env.PHOTO_BUCKET || localPhotoDir());
}

let client: S3Client | undefined;
function s3(): S3Client {
  // Default credential chain: the EC2 instance role in production.
  client ??= new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' });
  return client;
}

function bucket(): string {
  const b = process.env.PHOTO_BUCKET;
  if (!b) throw new Error('PHOTO_BUCKET is not set');
  return b;
}

export function presignWastageUpload(
  tenantId: string,
  nodeId: string,
  contentType: PhotoType,
): Promise<UploadTarget> {
  return presignPhotoUpload('wastage', tenantId, nodeId, contentType);
}

export function presignPhotoUpload(
  prefix: PhotoPrefix,
  tenantId: string,
  nodeId: string,
  contentType: PhotoType,
): Promise<UploadTarget> {
  if (localPhotoDir())
    return Promise.resolve(presignLocalUpload(prefix, tenantId, nodeId, contentType));
  return presignUpload(s3(), bucket(), prefix, tenantId, nodeId, contentType);
}

/** A presigned POST for one bill file (photo or PDF) at the bill's store (ADR 050). */
export function presignBillUpload(
  tenantId: string,
  nodeId: string,
  contentType: BillFileType,
): Promise<UploadTarget> {
  if (localPhotoDir())
    return Promise.resolve(presignLocalUpload('bills', tenantId, nodeId, contentType));
  return presignUpload(s3(), bucket(), 'bills', tenantId, nodeId, contentType);
}

/** A presigned POST for one licence or compliance document (photo or PDF) at an outlet (ADR 069). */
export function presignComplianceUpload(
  tenantId: string,
  outletId: string,
  contentType: BillFileType,
): Promise<UploadTarget> {
  if (localPhotoDir()) {
    return Promise.resolve(presignLocalUpload('compliance', tenantId, outletId, contentType));
  }
  return presignUpload(s3(), bucket(), 'compliance', tenantId, outletId, contentType);
}

/** Copies a photo to another key in the bucket (a routine task photo kept for 400 days). */
export async function copyPhoto(from: string, to: string): Promise<void> {
  if (localPhotoDir()) return copyLocalPhoto(from, to);
  await s3().send(
    new CopyObjectCommand({ Bucket: bucket(), CopySource: `${bucket()}/${from}`, Key: to }),
  );
}

export function presignPhotoView(key: string): Promise<string> {
  if (localPhotoDir()) return Promise.resolve(presignLocalView(key));
  return presignView(s3(), bucket(), key);
}

/** 5-minute GET URLs for item photos (ADR 034), by item; none when photos are off. */
export async function itemPhotoUrls(
  rows: readonly { item_id: string; photo_key: string | null }[],
): Promise<Map<string, string>> {
  if (!photosEnabled()) return new Map();
  const withPhoto = rows.filter((r) => r.photo_key);
  const urls = await Promise.all(withPhoto.map((r) => presignPhotoView(r.photo_key!)));
  return new Map(withPhoto.map((r, i) => [r.item_id, urls[i]!]));
}
