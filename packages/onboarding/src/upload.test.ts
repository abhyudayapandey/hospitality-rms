import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readCustomerDir } from './dir';
import { MAX_UPLOAD_BYTES, readUpload, UploadError, zipFiles, type UploadPart } from './upload';
import { DirUploadStore, uploadKey } from './upload-store';

// The console's upload reader (ADR 013): a zip or the CSV files, only the numbered
// onboarding files kept, sizes checked before inflating, no path escapes.

const company = readCustomerDir(
  new URL('../../../docs/onboarding/test-data/test-company', import.meta.url).pathname,
);
const zip = (name: string, bytes: Uint8Array): UploadPart[] => [{ name, bytes }];

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof UploadError) return err.code;
    throw err;
  }
  return 'ok';
}

describe('readUpload', () => {
  it('reads the test company zip, at the top level or in one folder', () => {
    for (const folder of ['', 'test-company']) {
      const r = readUpload(zip('test-company.zip', zipFiles(company, folder)));
      expect(r.customerCode).toBe('TEST-COMPANY');
      expect(r.files).toEqual(company);
    }
  });

  it('reads the CSV files themselves', () => {
    const parts = Object.entries(company).map(([name, content]) => ({
      name,
      bytes: strToU8(content),
    }));
    expect(readUpload(parts).files).toEqual(company);
  });

  it('keeps only the numbered onboarding files: never a logins file with passwords', () => {
    const r = readUpload(
      zip(
        'bundle.zip',
        zipSync({
          'x/00_customer.csv': strToU8(company['00_customer.csv']!),
          'x/TEST_LOGINS_do_not_commit.csv': strToU8('username,password\na,TestA!12\n'),
          'x/README.md': strToU8('# hi'),
          '__MACOSX/x/._00_customer.csv': strToU8('junk'),
          'x/.DS_Store': strToU8('junk'),
        }),
      ),
    );
    expect(Object.keys(r.files)).toEqual(['00_customer.csv']);
  });

  it('refuses names that could escape a folder', () => {
    for (const name of ['../00_customer.csv', '/etc/00_customer.csv', 'a\\00_customer.csv']) {
      const bytes = zipSync({ [name]: strToU8(company['00_customer.csv']!) });
      expect(
        code(() => readUpload(zip('x.zip', bytes))),
        name,
      ).toBe('UPLOAD_UNSAFE_PATH');
    }
    expect(code(() => readUpload([{ name: '../00_customer.csv', bytes: strToU8('x') }]))).toBe(
      'UPLOAD_UNSAFE_PATH',
    );
  });

  it('refuses files from more than one folder, and the same file twice', () => {
    const two = zipSync({
      'a/00_customer.csv': strToU8(company['00_customer.csv']!),
      'b/07_users.csv': strToU8(company['07_users.csv']!),
    });
    expect(code(() => readUpload(zip('x.zip', two)))).toBe('UPLOAD_FOLDERS');
    const csv = strToU8(company['00_customer.csv']!);
    expect(
      code(() =>
        readUpload([
          { name: '00_customer.csv', bytes: csv },
          { name: '00_customer.csv', bytes: csv },
        ]),
      ),
    ).toBe('UPLOAD_DUPLICATE');
  });

  it('checks size and type before reading', () => {
    expect(code(() => readUpload([]))).toBe('UPLOAD_EMPTY');
    expect(code(() => readUpload(zip('x.zip', new Uint8Array(MAX_UPLOAD_BYTES + 1))))).toBe(
      'UPLOAD_TOO_LARGE',
    );
    expect(code(() => readUpload(zip('x.zip', strToU8('not a zip'))))).toBe('UPLOAD_TYPE');
    expect(code(() => readUpload(zip('x.pdf', strToU8('%PDF'))))).toBe('UPLOAD_TYPE');
    // a zip renamed .csv is not a CSV
    expect(code(() => readUpload(zip('00_customer.csv', zipFiles(company))))).toBe('UPLOAD_TYPE');
    // a broken zip
    const broken = zipFiles(company).slice(0, 200);
    expect(code(() => readUpload(zip('x.zip', broken)))).toBe('UPLOAD_TYPE');
  });

  it('refuses a zip that inflates past the limits (a zip bomb)', () => {
    // 11 MB of one character compresses to a few kilobytes
    const bomb = zipSync({ '00_customer.csv': new Uint8Array(11 * 1024 * 1024).fill(65) });
    expect(bomb.length).toBeLessThan(MAX_UPLOAD_BYTES);
    expect(code(() => readUpload(zip('x.zip', bomb)))).toBe('UPLOAD_TOO_LARGE');
  });

  it('needs UTF-8 and a file 00', () => {
    const latin1 = new Uint8Array([0x63, 0x6f, 0x64, 0x65, 0x0a, 0xe9, 0x0a]);
    expect(code(() => readUpload([{ name: '00_customer.csv', bytes: latin1 }]))).toBe(
      'UPLOAD_NOT_UTF8',
    );
    expect(
      code(() => readUpload([{ name: '07_users.csv', bytes: strToU8(company['07_users.csv']!) }])),
    ).toBe('UPLOAD_NO_CUSTOMER_FILE');
  });
});

describe('the upload store', () => {
  it('keeps uploads under onboarding/<customer>/<upload>.json only', async () => {
    const t = '0192d6a0-0000-7000-8000-000000000001';
    const u = '0192d6a0-0000-7000-8000-000000000002';
    expect(uploadKey(t, u)).toBe(`onboarding/${t}/${u}.json`);
    expect(() => uploadKey('../x', u)).toThrow();
    const dir = await import('node:fs/promises').then((fs) =>
      fs.mkdtemp(`${(process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')}/oo-upload-`),
    );
    const store = new DirUploadStore(dir);
    await store.put(uploadKey(t, u), { files: { '00_customer.csv': 'x' } });
    expect(await store.get(uploadKey(t, u))).toEqual({ files: { '00_customer.csv': 'x' } });
    await expect(store.get('onboarding/../../etc/passwd')).rejects.toThrow('bad upload key');
  });
});
