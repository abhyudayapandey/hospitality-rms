import { unzipSync, zipSync, strToU8 } from 'fflate';
import { parseCsv } from './csv';

// Reading a customer's onboarding upload in the Platform Admin console (ADR 013): one zip,
// or the CSV files themselves. Only the numbered onboarding files are kept (a stray
// TEST_LOGINS file with passwords, a README or the Mac's __MACOSX folder never get
// stored); a zip may hold them at its top level or in one folder. Sizes are checked
// before anything is inflated and again after, and names that could escape a folder are
// refused.

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 50;

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
  | 'UPLOAD_NO_CUSTOMER_FILE';

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

function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  let total = 0;
  let count = 0;
  const folders = new Set<string>();
  const kept = new Map<string, string>(); // file -> full entry name
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter(f) {
        const [folder, file] = entryPath(f.name);
        if (f.name.endsWith('/') || folder.split('/')[0] === '__MACOSX' || file.startsWith('.')) {
          return false;
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
  return out;
}

export function readUpload(parts: UploadPart[]): ReadUpload {
  const real = parts.filter((p) => p.bytes.length > 0);
  if (!real.length) throw new UploadError('UPLOAD_EMPTY');
  const size = real.reduce((n, p) => n + p.bytes.length, 0);
  if (size > MAX_UPLOAD_BYTES) throw new UploadError('UPLOAD_TOO_LARGE', `${size} bytes`);

  let raw: Map<string, Uint8Array>;
  if (real.length === 1 && /\.zip$/i.test(real[0]!.name)) {
    if (!isZip(real[0]!.bytes)) throw new UploadError('UPLOAD_TYPE', real[0]!.name);
    raw = readZip(real[0]!.bytes);
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
  return { files, customerCode };
}

/** A zip of onboarding files (tests and e2e build uploads with it). */
export function zipFiles(files: Record<string, string>, folder = ''): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    entries[folder ? `${folder}/${name}` : name] = strToU8(content);
  }
  return zipSync(entries);
}
