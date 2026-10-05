import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import {
  isBillFileType,
  isPhotoType,
  MAX_BILL_BYTES,
  keptKey,
  MAX_PHOTO_BYTES,
  photoKeyPattern,
  presignUpload,
  presignView,
  wastageKeyPattern,
} from './photo-policy';

// Presigning is local (no AWS call), so fake credentials are enough to inspect the
// policy S3 will enforce.
const client = new S3Client({
  region: 'ap-south-1',
  credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'example-secret' },
});
const TENANT = '01920000-0000-7000-8000-000000000001';
const NODE = '01920000-0000-7000-8000-000000000203';

describe('wastage photo upload policy', () => {
  it('pins the key prefix, the content type, 1 byte..5 MB and 5 minutes', async () => {
    const t = await presignUpload(client, 'photos-bucket', 'wastage', TENANT, NODE, 'image/jpeg');
    expect(t.key).toMatch(wastageKeyPattern(TENANT, NODE));
    expect(t.url).toContain('photos-bucket');
    const policy = JSON.parse(Buffer.from(t.fields.Policy!, 'base64').toString()) as {
      expiration: string;
      conditions: unknown[];
    };
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        ['content-length-range', 1, MAX_PHOTO_BYTES],
        ['eq', '$Content-Type', 'image/jpeg'],
        { bucket: 'photos-bucket' },
        { key: t.key },
      ]),
    );
    const ttl = (Date.parse(policy.expiration) - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(250);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('accepts only jpeg, png and webp, and keys only under the tenant and node', () => {
    expect(['image/jpeg', 'image/png', 'image/webp'].every(isPhotoType)).toBe(true);
    expect(isPhotoType('image/gif')).toBe(false);
    expect(isPhotoType('text/html')).toBe(false);
    const re = wastageKeyPattern(TENANT, NODE);
    expect(re.test(`wastage/${TENANT}/${NODE}/${crypto.randomUUID()}.png`)).toBe(true);
    expect(re.test(`wastage/${TENANT}/other/${crypto.randomUUID()}.png`)).toBe(false);
    expect(re.test(`wastage/${TENANT}/${NODE}/../x.png`)).toBe(false);
  });

  it('puts task photos under tasks/routine or tasks/keep, and keeps a routine one by name', async () => {
    const t = await presignUpload(client, 'b', 'tasks/routine', TENANT, NODE, 'image/webp');
    expect(t.key).toMatch(photoKeyPattern('tasks/routine', TENANT, NODE));
    expect(t.key).not.toMatch(photoKeyPattern('tasks/keep', TENANT, NODE));
    expect(keptKey(t.key)).toBe(t.key.replace('tasks/routine/', 'tasks/keep/'));
    expect(keptKey(t.key.replace('tasks/routine/', 'wastage/'))).toBeNull();
    expect(keptKey(`tasks/routine/${TENANT}/${NODE}/../x.jpg`)).toBeNull();
  });

  it('issues short-lived GET URLs', async () => {
    const url = new URL(await presignView(client, 'photos-bucket', 'wastage/a/b/c.jpg'));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('takes PDFs up to 10 MB for bills only (ADR 050)', async () => {
    expect(isBillFileType('application/pdf')).toBe(true);
    expect(isBillFileType('image/jpeg')).toBe(true);
    expect(isBillFileType('text/html')).toBe(false);
    expect(isPhotoType('application/pdf')).toBe(false);
    const t = await presignUpload(client, 'b', 'bills', TENANT, NODE, 'application/pdf');
    expect(t.key).toMatch(new RegExp(`^bills/${TENANT}/${NODE}/[0-9a-f-]{36}\\.pdf$`));
    const policy = JSON.parse(Buffer.from(t.fields.Policy!, 'base64').toString()) as {
      conditions: unknown[];
    };
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        ['content-length-range', 1, MAX_BILL_BYTES],
        ['eq', '$Content-Type', 'application/pdf'],
      ]),
    );
    await expect(
      presignUpload(client, 'b', 'wastage', TENANT, NODE, 'application/pdf'),
    ).rejects.toThrow('INVALID_PHOTO');
  });
});
