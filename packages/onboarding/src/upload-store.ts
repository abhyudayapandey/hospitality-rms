import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

// Where the console keeps an upload between the dry run and the apply (ADR 013): the
// private photo bucket under onboarding/<customer>/<upload>.json, which expires after 30
// days. The web app writes it and the platform worker reads it, both with the instance
// role. Without a bucket (dev, e2e) a local folder stands in.

export interface StoredUpload {
  files: Record<string, string>;
  /** Dish photos (ADR 078): file name -> base64 */
  photos?: Record<string, string>;
}

export const photosToStore = (photos: Record<string, Uint8Array>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(photos).map(([n, b]) => [n, Buffer.from(b).toString('base64')]),
  );

export const photosFromStore = (
  photos: Record<string, string> | undefined,
): Record<string, Uint8Array> =>
  Object.fromEntries(
    Object.entries(photos ?? {}).map(([n, b]) => [n, new Uint8Array(Buffer.from(b, 'base64'))]),
  );

/** Where an applied import puts a dish's photo: the photo bucket's items/ prefix (ADR 078). */
export type PutPhoto = (key: string, bytes: Uint8Array, contentType: string) => Promise<void>;

const PHOTO_KEY = /^items\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

export function photoStore(env: Record<string, string | undefined> = process.env): PutPhoto {
  if (env.PHOTO_BUCKET) {
    const client = new S3Client({ region: env.AWS_REGION ?? 'ap-south-1' });
    const bucket = env.PHOTO_BUCKET;
    return async (key, bytes, contentType) => {
      if (!PHOTO_KEY.test(key)) throw new Error('bad photo key');
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          ServerSideEncryption: 'AES256',
        }),
      );
    };
  }
  // dev and e2e: a local folder stands in (the app shows no photos without a bucket)
  const dir = env.ONBOARDING_UPLOAD_DIR || join(tmpdir(), 'outlet-ops-onboarding');
  return async (key, bytes) => {
    if (!PHOTO_KEY.test(key)) throw new Error('bad photo key');
    const path = join(dir, key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });
  };
}

export interface UploadStore {
  put(key: string, upload: StoredUpload): Promise<void>;
  get(key: string): Promise<StoredUpload>;
}

const KEY = /^onboarding\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.json$/;

export function uploadKey(tenantId: string, uploadId: string): string {
  const key = `onboarding/${tenantId}/${uploadId}.json`;
  if (!KEY.test(key)) throw new Error('bad upload key');
  return key;
}

function checked(key: string): string {
  if (!KEY.test(key)) throw new Error('bad upload key');
  return key;
}

/** The subset of the S3 client the store uses (tests pass a fake). */
export interface S3Sender {
  send(command: object): Promise<unknown>;
}

export class S3UploadStore implements UploadStore {
  constructor(
    private readonly client: S3Sender,
    private readonly bucket: string,
  ) {}

  async put(key: string, upload: StoredUpload): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: checked(key),
        Body: JSON.stringify(upload),
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async get(key: string): Promise<StoredUpload> {
    const r = (await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: checked(key) }),
    )) as { Body?: { transformToString(): Promise<string> } };
    if (!r.Body) throw new Error(`upload ${key} is empty`);
    return JSON.parse(await r.Body.transformToString()) as StoredUpload;
  }
}

export class DirUploadStore implements UploadStore {
  constructor(private readonly dir: string) {}

  async put(key: string, upload: StoredUpload): Promise<void> {
    const path = join(this.dir, checked(key));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(upload), { mode: 0o600 });
  }

  async get(key: string): Promise<StoredUpload> {
    return JSON.parse(await readFile(join(this.dir, checked(key)), 'utf8')) as StoredUpload;
  }
}

/** The photo bucket when PHOTO_BUCKET is set (production), else a local folder. */
export function uploadStore(env: Record<string, string | undefined> = process.env): UploadStore {
  if (env.PHOTO_BUCKET) {
    return new S3UploadStore(
      new S3Client({ region: env.AWS_REGION ?? 'ap-south-1' }),
      env.PHOTO_BUCKET,
    );
  }
  return new DirUploadStore(env.ONBOARDING_UPLOAD_DIR || join(tmpdir(), 'outlet-ops-onboarding'));
}
