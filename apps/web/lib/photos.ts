import 'server-only';
import { S3Client } from '@aws-sdk/client-s3';
import { presignUpload, presignView, type PhotoType, type UploadTarget } from './photo-policy';

// Wastage photos (ADR 006): a private S3 bucket (PHOTO_BUCKET), written and read only
// through short-lived presigned URLs issued here with the instance role's credentials.
// Callers check core.can() in SQL before asking for a URL (never in TypeScript).

export {
  isPhotoType,
  MAX_PHOTO_BYTES,
  wastageKeyPattern,
  type PhotoType,
  type UploadTarget,
} from './photo-policy';

export function photosEnabled(): boolean {
  return Boolean(process.env.PHOTO_BUCKET);
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
  return presignUpload(s3(), bucket(), tenantId, nodeId, contentType);
}

export function presignPhotoView(key: string): Promise<string> {
  return presignView(s3(), bucket(), key);
}
