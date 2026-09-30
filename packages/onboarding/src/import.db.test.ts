import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCustomerDir } from './dir';
import type { InviteSender } from './invites';
import type { ImportReport, InviteProgress } from './report';
import { DirUploadStore, uploadKey, type UploadStore } from './upload-store';
import { runNextJob } from './worker';

// The worker's import and invite jobs (ADR 013), as platform_loader: the customer-code
// guard, dry run then apply (twice: the second changes nothing), and invitations that
// stay within the daily allowance and wait for the rest.

afterAll(closePools);

const data = (dir: string) =>
  readCustomerDir(new URL(`../../../docs/onboarding/test-data/${dir}`, import.meta.url).pathname);
const company = data('test-company');
const solo = data('test-solo-bar-co');

let store: UploadStore;
beforeAll(async () => {
  store = new DirUploadStore(await mkdtemp(join(tmpdir(), 'oo-import-')));
});

async function tenantOf(c: PoolClient, code: string): Promise<string> {
  return (await c.query<{ id: string }>('select id from core.tenant where code = $1', [code]))
    .rows[0]!.id;
}

let n = 0;
/** Stores `files` for `tenant` and queues a job of `kind` for it (as the console would). */
async function queue(
  c: PoolClient,
  kind: 'import_dry_run' | 'import_apply' | 'invite_logins',
  tenant: string,
  files?: Record<string, string>,
): Promise<string> {
  let payload = {};
  if (files) {
    const key = uploadKey(tenant, `0192d6a0-0000-7000-8000-${String(++n).padStart(12, '0')}`);
    await store.put(key, { files });
    payload = { key };
  }
  // other queued jobs (e.g. from e2e) are set aside so the worker takes this one
  await c.query(`update platform.job set status = 'done' where status = 'queued'`);
  return (
    await c.query<{ id: string }>(
      `insert into platform.job (kind, tenant_id, payload) values ($1, $2, $3) returning id`,
      [kind, tenant, payload],
    )
  ).rows[0]!.id;
}

async function work(c: PoolClient, invites?: InviteSender) {
  await c.query('set local role platform_loader');
  try {
    return await runNextJob(c, { nested: true, store, ...(invites ? { invites } : {}) });
  } finally {
    await c.query('reset role');
  }
}

async function jobRow<R>(c: PoolClient, id: string) {
  return (
    await c.query<{ status: string; result: R; error: string | null; run_after: Date | null }>(
      'select status, result, error, run_after from platform.job where id = $1',
      [id],
    )
  ).rows[0]!;
}

const supplierEmail = (c: PoolClient, tenant: string) =>
  c
    .query<{ contact: string }>(
      `select contact from inv.supplier where tenant_id = $1 and code = 'SUPPLIER-FRESH-PRODUCE'`,
      [tenant],
    )
    .then((r) => r.rows[0]!.contact);

describe('import jobs', () => {
  it('a dry run of the loaded files reports no changes and changes nothing', async () => {
    await inRolledBackTx(async (c) => {
      const t = await tenantOf(c, 'TEST-COMPANY');
      const job = await queue(c, 'import_dry_run', t, company);
      expect(await work(c)).toBe(job);
      const r = await jobRow<ImportReport>(c, job);
      expect(r.status).toBe('done');
      expect(r.result).toMatchObject({ ok: true, applied: false, changes: 0, issues: [] });
      expect(r.result.files).toContain('07_users.csv');
      expect(Object.keys(r.result.counts)).toContain('users');
    });
  });

  it('refuses files for another customer and writes nothing', async () => {
    await inRolledBackTx(async (c) => {
      const t = await tenantOf(c, 'TEST-SOLO-COMPANY');
      const before = await supplierEmail(c, await tenantOf(c, 'TEST-COMPANY'));
      const changed = {
        ...company,
        '09_suppliers.csv': company['09_suppliers.csv']!.replace(
          'fresh-produce@test-supplier.example',
          'changed@test-supplier.example',
        ),
      };
      for (const kind of ['import_dry_run', 'import_apply'] as const) {
        const job = await queue(c, kind, t, changed);
        await work(c);
        const r = await jobRow(c, job);
        expect(r.status, kind).toBe('failed');
        expect(r.error).toBe(
          'CUSTOMER_MISMATCH: file 00 names TEST-COMPANY, not TEST-SOLO-COMPANY',
        );
      }
      expect(await supplierEmail(c, await tenantOf(c, 'TEST-COMPANY'))).toBe(before);
    });
  });

  it('dry run, apply, apply again: the second apply reports no changes', async () => {
    await inRolledBackTx(async (c) => {
      const t = await tenantOf(c, 'TEST-COMPANY');
      const changed = {
        ...company,
        '09_suppliers.csv': company['09_suppliers.csv']!.replace(
          'fresh-produce@test-supplier.example',
          'orders@fresh-produce.example',
        ),
      };
      const dry = await queue(c, 'import_dry_run', t, changed);
      await work(c);
      expect((await jobRow<ImportReport>(c, dry)).result).toMatchObject({ ok: true, changes: 1 });
      expect(await supplierEmail(c, t)).toBe('fresh-produce@test-supplier.example');

      const first = await queue(c, 'import_apply', t, changed);
      await work(c);
      const a = await jobRow<ImportReport>(c, first);
      expect(a.status).toBe('done');
      expect(a.result).toMatchObject({ ok: true, applied: true, changes: 1 });
      expect(a.result.counts.suppliers).toMatchObject({ updated: 1 });
      expect(await supplierEmail(c, t)).toBe('orders@fresh-produce.example');

      const second = await queue(c, 'import_apply', t, changed);
      await work(c);
      expect((await jobRow<ImportReport>(c, second)).result).toMatchObject({
        ok: true,
        applied: true,
        changes: 0,
      });
    });
  });

  it('problems in the files: the report lists them with file, row and column', async () => {
    await inRolledBackTx(async (c) => {
      const t = await tenantOf(c, 'TEST-SOLO-COMPANY');
      const broken = {
        ...solo,
        '07_users.csv': solo['07_users.csv']!.replace(',BAR_MANAGER,', ',NO_SUCH_ROLE,'),
      };
      const job = await queue(c, 'import_dry_run', t, broken);
      await work(c);
      const r = await jobRow<ImportReport>(c, job);
      expect(r.status).toBe('failed');
      expect(r.error).toMatch(/problems? found; nothing was changed/);
      expect(r.result.ok).toBe(false);
      expect(r.result.issues[0]).toMatchObject({ file: '07_users.csv', row: 2 });
    });
  });
});

describe('invite jobs', () => {
  it('send within the daily allowance; the rest wait in the queue until it frees up', async () => {
    await inRolledBackTx(async (c) => {
      const t = (
        await c.query<{ id: string }>(
          `insert into core.tenant (name, code, is_test) values ('Mail Co', 'MAIL-CO', false)
           returning id`,
        )
      ).rows[0]!.id;
      for (const k of [1, 2, 3]) {
        await c.query(
          `insert into core.app_user (tenant_id, kind, display_name, username, email, login_type)
           values ($1, 'human', $2, $3, $4, 'email')`,
          [t, `Person ${k}`, `mail-co.person.${k}`, `person${k}@mail-co.example`],
        );
      }
      // 48 invitations already went out today (other customers): 2 left of 50
      await c.query(`delete from platform.invite where sent_at > now() - interval '1 day'`);
      await c.query(
        `insert into platform.invite (tenant_id, user_id, sent_at)
         select tenant_id, id, now() - interval '1 hour' from core.app_user
          where kind = 'human' limit 48`,
      );
      const sent: string[] = [];
      const sender: InviteSender = {
        invite: (p) => {
          sent.push(p.email);
          return Promise.resolve({ sub: `sub-${p.username}`, sent: true });
        },
      };
      const job = await queue(c, 'invite_logins', t);
      await work(c, sender);
      expect(sent).toEqual(['person1@mail-co.example', 'person2@mail-co.example']);
      const waiting = await jobRow<InviteProgress>(c, job);
      expect(waiting.status).toBe('queued');
      expect(waiting.result).toEqual({ sent: 2, waiting: 1 });
      expect(waiting.run_after!.getTime()).toBeGreaterThan(Date.now() + 22 * 3600 * 1000);
      // not due yet: the worker leaves it alone
      expect(await work(c, sender)).toBeNull();

      // a day later
      await c.query(`update platform.invite set sent_at = sent_at - interval '1 day'`);
      await c.query(
        `update platform.job set run_after = now() - interval '1 second' where id = $1`,
        [job],
      );
      await work(c, sender);
      expect(sent).toHaveLength(3);
      const done = await jobRow<InviteProgress>(c, job);
      expect(done.status).toBe('done');
      expect(done.result).toEqual({ sent: 1, waiting: 0 });
      const subs = await c.query<{ cognito_sub: string }>(
        `select cognito_sub from core.app_user where tenant_id = $1 order by username`,
        [t],
      );
      expect(subs.rows.map((r) => r.cognito_sub)).toEqual([
        'sub-mail-co.person.1',
        'sub-mail-co.person.2',
        'sub-mail-co.person.3',
      ]);
    });
  });
});
