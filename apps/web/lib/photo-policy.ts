import { randomUUID } from 'node:crypto';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// The presign rules for photos (wastage, ADR 006; tasks and maintenance, ADR 020), free of server-only/env so unit tests
// can exercise them with fake credentials. lib/photos.ts supplies bucket and client.

export const PHOTO_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;
export type PhotoType = keyof typeof PHOTO_TYPES;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const URL_TTL_SECONDS = 300;

export function isPhotoType(t: string): t is PhotoType {
  return Object.hasOwn(PHOTO_TYPES, t);
}

/**
 * Where photos live. The bucket's lifecycle keeps tasks/routine/ 90 days and tasks/keep/
 * (flagged readings, maintenance) 400 days (ADR 020); items/ (item photos, ADR 034) as long
 * as the item, under items/<tenant>/<item>/.
 */
export const PHOTO_PREFIXES = [
  'wastage',
  'tasks/routine',
  'tasks/keep',
  'items',
  // stock check proof photos (INV-10, ADR 043): kept 5 years
  'stockcheck',
  // clock-in selfies (ATT-7, ADR 045): personnel data, kept under the retention rule
  'selfies',
] as const;
export type PhotoPrefix = (typeof PHOTO_PREFIXES)[number];

/** The only keys uploads may use: <prefix>/<tenant>/<node>/<uuid>.<ext>. */
export function photoKeyPattern(prefix: PhotoPrefix, tenantId: string, nodeId: string): RegExp {
  return new RegExp(`^${prefix}/${tenantId}/${nodeId}/[0-9a-f-]{36}\\.(jpg|png|webp)$`);
}

export function wastageKeyPattern(tenantId: string, nodeId: string): RegExp {
  return photoKeyPattern('wastage', tenantId, nodeId);
}

/** A routine task photo's key once kept (a flagged reading): same name under tasks/keep/. */
export function keptKey(key: string): string | null {
  return /^tasks\/routine\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(key)
    ? key.replace(/^tasks\/routine\//, 'tasks/keep/')
    : null;
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
export async function presignUpload(
  client: S3Client,
  bucket: string,
  prefix: PhotoPrefix,
  tenantId: string,
  nodeId: string,
  contentType: PhotoType,
): Promise<UploadTarget> {
  const key = `${prefix}/${tenantId}/${nodeId}/${randomUUID()}.${PHOTO_TYPES[contentType]}`;
  const { url, fields } = await createPresignedPost(client, {
    Bucket: bucket,
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
export function presignView(client: S3Client, bucket: string, key: string): Promise<string> {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: URL_TTL_SECONDS,
  });
}
