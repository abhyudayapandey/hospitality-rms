import 'server-only';
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Wastage photos (ADR 006): a private S3 bucket (PHOTO_BUCKET), written and read only
// through short-lived presigned URLs issued here with the instance role's credentials.
// Callers check core.can() in SQL before asking for a URL (never in TypeScript).

export const PHOTO_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;
export type PhotoType = keyof typeof PHOTO_TYPES;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const URL_TTL_SECONDS = 300;

export function photosEnabled(): boolean {
  return Boolean(process.env.PHOTO_BUCKET);
}

export function isPhotoType(t: string): t is PhotoType {
  return Object.hasOwn(PHOTO_TYPES, t);
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

/** The only keys uploads may use: wastage/<tenant>/<delivery node>/<uuid>.<ext>. */
export function wastageKeyPattern(tenantId: string, nodeId: string): RegExp {
  return new RegExp(`^wastage/${tenantId}/${nodeId}/[0-9a-f-]{36}\\.(jpg|png|webp)$`);
}

export interface UploadTarget {
  url: string;
  fields: Record<string, string>;
  key: string;
}

/**
 * A presigned POST for one photo: fixed key under the node's prefix, exact content type,
 * 1 byte to 5 MB, valid for 5 minutes. S3 enforces all of it.
 */
export async function presignWastageUpload(
  tenantId: string,
  nodeId: string,
  contentType: PhotoType,
  client: S3Client = s3(),
): Promise<UploadTarget> {
  const key = `wastage/${tenantId}/${nodeId}/${randomUUID()}.${PHOTO_TYPES[contentType]}`;
  const { url, fields } = await createPresignedPost(client, {
    Bucket: bucket(),
    Key: key,
    Conditions: [
      ['content-length-range', 1, MAX_PHOTO_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: URL_TTL_SECONDS,
  });
  return { url, fields, key };
}

/** A 5-minute GET URL for a stored photo. */
export async function presignPhotoView(key: string, client: S3Client = s3()): Promise<string> {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: URL_TTL_SECONDS,
  });
}
