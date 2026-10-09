import { unzipSync, zipSync, strToU8 } from 'fflate';
import { parseCsv } from './csv';

// Reading a customer's onboarding upload in the Platform Admin console (ADR 013): one zip,
// or the CSV files themselves. Only the numbered onboarding files are kept (a stray
// TEST_LOGINS file with passwords, a README or the Mac's __MACOSX folder never get
// stored); a zip may hold them at its top level or in one folder. Sizes are checked
// before anything is inflated and again after, and names that could escape a folder are
// refused. A zip may also carry the dishes' photos in photos/menu/ beside the files, one per
// dish, named by its code (ADR 078); they are checked here and loaded by the loader.

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
export const MAX_FILES = 50;
export const MAX_PHOTOS = 300;
export const MAX_DISH_PHOTO_BYTES = 2 * 1024 * 1024;

/** BUTTER-CHICKEN.jpg: a dish's code, then the picture's type. */
const DISH_PHOTO = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.(jpg|jpeg|png|webp)$/;

/** 00_customer.csv, 07_users.csv, ... (99_access_preview_GENERATED.csv too: ignored later). */
const ONBOARDING_FILE = /^\d\d_[a-z0-9_]+\.csv$/i;

export type UploadErrorCode =
  | 'UPLOAD_EMPTY'
  | 'UPLOAD_TOO_LARGE'
  | 'UPLOAD_TYPE'
  | 'UPLOAD_UNSAFE_PATH'
  | 'UPLOAD_FOLDERS'
  | 'UPLOAD_DUPLICATE'
  | 'UPLOAD_NOT_UTF8'
  | 'UPLOAD_NO_CUSTOMER_FILE'
  | 'UPLOAD_PHOTO';

export class UploadError extends Error {
  constructor(
    readonly code: UploadErrorCode,
    readonly detail?: string,
  ) {
    super(code);
  }
}

export interface UploadPart {
  name: string;
  bytes: Uint8Array;
}

export interface ReadUpload {
  /** Onboarding file name -> content, as the loader takes it. */
  files: Record<string, string>;
  /** The customer code in 00_customer.csv. */
  customerCode: string;
  /** Dish photos from photos/menu/ (file name -> bytes), checked by checkDishPhotos. */
  photos: Record<string, Uint8Array>;
}

export type DishPhotoType = 'image/jpeg' | 'image/png' | 'image/webp';

/** The picture's real type from its first bytes (never the name alone). */
export function photoTypeOf(b: Uint8Array): DishPhotoType | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'image/png';
  }
  if (
    b.length > 12 &&
    String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...b.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * The dish photos' own checks: a name that is a code and a picture type, one photo per
 * code, a real JPEG, PNG or WebP of at most 2 MB, at most 300. Returns code -> photo.
 */
export function checkDishPhotos(
  photos: Record<string, Uint8Array>,
): Map<string, { name: string; bytes: Uint8Array; type: DishPhotoType }> {
  const names = Object.keys(photos);
  if (names.length > MAX_PHOTOS) throw new UploadError('UPLOAD_TOO_LARGE', 'too many photos');
  const out = new Map<string, { name: string; bytes: Uint8Array; type: DishPhotoType }>();
  for (const name of names.sort()) {
    const m = DISH_PHOTO.exec(name);
    const bytes = photos[name]!;
    if (!m) throw new UploadError('UPLOAD_PHOTO', `${name}: name it after the dish's code`);
    if (bytes.length > MAX_DISH_PHOTO_BYTES) {
      throw new UploadError('UPLOAD_PHOTO', `${name}: larger than 2 MB`);
    }
    const type = photoTypeOf(bytes);
    if (!type) throw new UploadError('UPLOAD_PHOTO', `${name}: not a JPEG, PNG or WebP picture`);
    const code = m[1]!.toUpperCase();
    if (out.has(code)) throw new UploadError('UPLOAD_DUPLICATE', `photos/menu/${name}`);
    out.set(code, { name, bytes, type });
  }
  return out;
}

const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b;
const decoder = new TextDecoder('utf-8', { fatal: true });

function text(name: string, bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new UploadError('UPLOAD_NOT_UTF8', name);
  }
}

/** A zip entry's path: no absolute paths, no .., no backslashes; returns [folder, file]. */
function entryPath(name: string): [string, string] {
  if (name.startsWith('/') || name.includes('\\') || name.split('/').some((p) => p === '..')) {
    throw new UploadError('UPLOAD_UNSAFE_PATH', name);
  }
  const parts = name.split('/').filter(Boolean);
  const file = parts.pop() ?? '';
  return [parts.join('/'), file];
}

function readZip(bytes: Uint8Array): {
  files: Map<string, Uint8Array>;
  photos: Record<string, Uint8Array>;
} {
  let total = 0;
  let count = 0;
  let photoCount = 0;
  const folders = new Set<string>();
  const kept = new Map<string, string>(); // file -> full entry name
  const photoEntries = new Map<string, [string, string]>(); // entry -> [folder, file]
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter(f) {
        const [folder, file] = entryPath(f.name);
        if (f.name.endsWith('/') || folder.split('/')[0] === '__MACOSX' || file.startsWith('.')) {
          return false;
        }
        if (/(^|\/)photos\/menu$/.test(folder) && DISH_PHOTO.test(file)) {
          if (++photoCount > MAX_PHOTOS)
            throw new UploadError('UPLOAD_TOO_LARGE', 'too many photos');
          if (
            f.originalSize > MAX_DISH_PHOTO_BYTES ||
            (total += f.originalSize) > MAX_TOTAL_BYTES
          ) {
            throw new UploadError('UPLOAD_TOO_LARGE', f.name);
          }
          photoEntries.set(f.name, [folder, file]);
          return true;
        }
        if (!ONBOARDING_FILE.test(file)) return false;
        if (++count > MAX_FILES) throw new UploadError('UPLOAD_TOO_LARGE', 'too many files');
        if (f.originalSize > MAX_FILE_BYTES || (total += f.originalSize) > MAX_TOTAL_BYTES) {
          throw new UploadError('UPLOAD_TOO_LARGE', f.name);
        }
        if (kept.has(file)) throw new UploadError('UPLOAD_DUPLICATE', file);
        folders.add(folder);
        if (folders.size > 1) throw new UploadError('UPLOAD_FOLDERS', [...folders].join(', '));
        kept.set(file, f.name);
        return true;
      },
    });
  } catch (err) {
    if (err instanceof UploadError) throw err;
    throw new UploadError('UPLOAD_TYPE', 'not a readable zip file');
  }
  const out = new Map<string, Uint8Array>();
  let inflated = 0;
  for (const [file, entry] of kept) {
    const data = entries[entry]!;
    // the sizes in a zip's headers are not trusted on their own
    if (data.length > MAX_FILE_BYTES || (inflated += data.length) > MAX_TOTAL_BYTES) {
      throw new UploadError('UPLOAD_TOO_LARGE', entry);
    }
    out.set(file, data);
  }
  // the photos sit beside the files: <the files' folder>/photos/menu/
  const root = [...folders][0] ?? '';
  const photos: Record<string, Uint8Array> = {};
  for (const [entry, [folder, file]] of photoEntries) {
    if (folder !== (root ? `${root}/photos/menu` : 'photos/menu')) {
      throw new UploadError('UPLOAD_FOLDERS', folder);
    }
    const data = entries[entry]!;
    if (data.length > MAX_DISH_PHOTO_BYTES || (inflated += data.length) > MAX_TOTAL_BYTES) {
      throw new UploadError('UPLOAD_TOO_LARGE', entry);
    }
    photos[file] = data;
  }
  return { files: out, photos };
}

export function readUpload(parts: UploadPart[]): ReadUpload {
  const real = parts.filter((p) => p.bytes.length > 0);
  if (!real.length) throw new UploadError('UPLOAD_EMPTY');
  const size = real.reduce((n, p) => n + p.bytes.length, 0);
  if (size > MAX_UPLOAD_BYTES) throw new UploadError('UPLOAD_TOO_LARGE', `${size} bytes`);

  let raw: Map<string, Uint8Array>;
  let photos: Record<string, Uint8Array> = {};
  if (real.length === 1 && /\.zip$/i.test(real[0]!.name)) {
    if (!isZip(real[0]!.bytes)) throw new UploadError('UPLOAD_TYPE', real[0]!.name);
    ({ files: raw, photos } = readZip(real[0]!.bytes));
    checkDishPhotos(photos);
  } else {
    raw = new Map();
    for (const p of real) {
      const [folder, file] = entryPath(p.name);
      if (folder || !/\.csv$/i.test(file) || isZip(p.bytes)) {
        throw new UploadError('UPLOAD_TYPE', p.name);
      }
      if (!ONBOARDING_FILE.test(file)) continue;
      if (raw.has(file)) throw new UploadError('UPLOAD_DUPLICATE', file);
      raw.set(file, p.bytes);
    }
  }

  const files: Record<string, string> = {};
  for (const [name, bytes] of [...raw].sort(([a], [b]) => a.localeCompare(b))) {
    files[name] = text(name, bytes);
  }
  const customer = files['00_customer.csv'];
  if (customer === undefined) throw new UploadError('UPLOAD_NO_CUSTOMER_FILE');
  let customerCode = '';
  try {
    customerCode = (parseCsv(customer).rows[0]?.values.customer_code ?? '').trim().toUpperCase();
  } catch {
    // the loader reports the file's problems with row and column
  }
  return { files, customerCode, photos };
}

/** A zip of onboarding files (tests and e2e build uploads with it). */
export function zipFiles(
  files: Record<string, string>,
  folder = '',
  photos: Record<string, Uint8Array> = {},
): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    entries[folder ? `${folder}/${name}` : name] = strToU8(content);
  }
  for (const [name, bytes] of Object.entries(photos)) {
    entries[`${folder ? `${folder}/` : ''}photos/menu/${name}`] = bytes;
  }
  return zipSync(entries);
}
