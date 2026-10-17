import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asPlatform,
  closePools,
  inRolledBackTx,
  newPlatformAdmin,
} from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCustomerDir } from './dir';
import type { ImportReport } from './report';
import { DirUploadStore, uploadKey, type UploadStore } from './upload-store';
import { runNextJob } from './worker';

// Uploads are kept in the database (ADR 169), not only in the photo bucket's onboarding/
// prefix, which expires after 30 days: an apply asked for late, and "Add an outlet" months
// after the last import, still find the files.

afterAll(closePools);

const company = readCustomerDir(
  new URL('../../../docs/onboarding/test-data/test-company', import.meta.url).pathname,
);

// a store with nothing in it: the bucket after the 30 days
let expired: UploadStore;
beforeAll(async () => {
  expired = new DirUploadStore(await mkdtemp(join(tmpdir(), 'oo-expired-')));
});

const tenantOf = async (c: PoolClient, code: string) =>
  (await c.query<{ id: string }>('select id from core.tenant where code = $1', [code])).rows[0]!.id;

const keyFor = (tenant: string, n: number) =>
  uploadKey(tenant, `0192d6a0-0000-7000-8000-${String(n).padStart(12, '0')}`);

// other queued jobs (e.g. from e2e) are set aside so the worker takes this test's
const setAside = (c: PoolClient) =>
  c.query(`update platform.job set status = 'done' where status = 'queued'`);

async function work(c: PoolClient) {
  await c.query('set local role platform_loader');
  try {
    return await runNextJob(c, { nested: true, store: expired });
  } finally {
    await c.query('reset role');
  }
}

const jobRow = async (c: PoolClient, id: string) =>
  (
    await c.query<{ status: string; result: ImportReport; error: string | null }>(
      'select status, result, error from platform.job where id = $1',
      [id],
    )
  ).rows[0]!;

describe('kept uploads', () => {
  it('only a platform admin keeps an upload, and only under its own customer', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const t = await tenantOf(c, 'TEST-COMPANY');
      const other = await tenantOf(c, 'TEST-SOLO-COMPANY');
      const keep = `select platform.keep_upload($1, $2::uuid, $3::jsonb, null)`;
      const files = JSON.stringify({ '00_customer.csv': 'x' });
      expect(await asPlatform(c, admin, keep, [keyFor(t, 1), t, files])).toEqual({
        rows: [{ keep_upload: '' }],
      });
      expect(await asPlatform(c, admin, keep, [keyFor(other, 2), t, files])).toEqual({
        error: 'bad upload key',
      });
      expect(await asPlatform(c, '', keep, [keyFor(t, 3), t, files])).toEqual({
        error: 'NOT_AUTHORISED',
      });
      // app_rw cannot read or write the table itself
      expect(await asPlatform(c, admin, 'select * from platform.upload')).toMatchObject({
        error: expect.stringMatching(/permission denied/) as string,
      });
    });
  });

  it('a dry run and an apply asked for after the bucket copy expired still run', async () => {
    await inRolledBackTx(async (c) => {
      await setAside(c);
      const admin = await newPlatformAdmin(c);
      const t = await tenantOf(c, 'TEST-COMPANY');
      const key = keyFor(t, 4);
      await asPlatform(c, admin, `select platform.keep_upload($1, $2::uuid, $3::jsonb, null)`, [
        key,
        t,
        JSON.stringify(company),
      ]);
      const dry = await asPlatform<{ id: string }>(
        c,
        admin,
        `select platform.request_import($1::uuid, $2::jsonb) as id`,
        [t, JSON.stringify({ key, customer_code: 'TEST-COMPANY' })],
      );
      if (!dry.rows) throw new Error(dry.error);
      await work(c);
      expect(await jobRow(c, dry.rows[0]!.id)).toMatchObject({ status: 'done', error: null });

      const apply = await asPlatform<{ id: string }>(
        c,
        admin,
        `select platform.request_import_apply($1::uuid) as id`,
        [dry.rows[0]!.id],
      );
      if (!apply.rows) throw new Error(apply.error);
      await work(c);
      const a = await jobRow(c, apply.rows[0]!.id);
      expect(a).toMatchObject({ status: 'done', error: null });
      expect(a.result).toMatchObject({ ok: true, applied: true });

      // "Add an outlet" starts from the applied files, read from the database
      const current = await asPlatform<{ files: Record<string, string> | null }>(
        c,
        admin,
        `select files from platform.current_files($1::uuid)`,
        [t],
      );
      expect(current).toEqual({ rows: [{ files: company }] });
    });
  });

  it('the worker reports a missing upload in plain words', async () => {
    await inRolledBackTx(async (c) => {
      await setAside(c);
      const t = await tenantOf(c, 'TEST-COMPANY');
      const job = (
        await c.query<{ id: string }>(
          `insert into platform.job (kind, tenant_id, payload) values ('import_dry_run', $1, $2)
           returning id`,
          [t, { key: keyFor(t, 5) }],
        )
      ).rows[0]!.id;
      await work(c);
      expect(await jobRow(c, job)).toMatchObject({
        status: 'failed',
        error: 'The uploaded files are no longer kept. Upload them again.',
      });
    });
  });
});
