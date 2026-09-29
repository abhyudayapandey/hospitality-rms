import { randomUUID } from 'node:crypto';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// The presign rules for wastage photos (ADR 006), free of server-only/env so unit tests
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
export async function presignUpload(
  client: S3Client,
  bucket: string,
  tenantId: string,
  nodeId: string,
  contentType: PhotoType,
): Promise<UploadTarget> {
  const key = `wastage/${tenantId}/${nodeId}/${randomUUID()}.${PHOTO_TYPES[contentType]}`;
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
