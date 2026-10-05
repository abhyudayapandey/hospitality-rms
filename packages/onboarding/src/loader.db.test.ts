import { join } from 'node:path';
import { closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadCustomer, type AccessRow } from './apply';
import { parseCsv } from './csv';
import { readCustomerDir } from './dir';

// The onboarding loader (ADR 009) against the two test customers in
// docs/onboarding/test-data: the access it produces is exactly each customer's generated
// preview, a dry run changes nothing, a second load changes nothing, and problems are
// reported by file, row and column (part 2, loader-checks.db.test.ts; the parts run side by
// side, ADR 029, 052).

afterAll(closePools);

// Every test here loads a whole customer, up to three times. That is 7 s on a laptop, but
// 60 to 130 s on a CI worker that shares its database with another, so the 120 s default
// (a hang guard) is too tight: the loads of Test Company timed out on one run and passed on
// the next. A longer limit here, a hang is still caught.
vi.setConfig({ testTimeout: 300_000 });

const DATA = join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding', 'test-data');
const CUSTOMERS = ['test-company', 'test-solo-bar-co'] as const;

const key = (r: AccessRow) =>
  [r.username, r.display_name, r.access_group, r.node_code, r.place_name, r.covers, r.source].join(
    ' | ',
  );

function preview(customer: string): string[] {
  const files = readCustomerDir(join(DATA, customer));
  const table = parseCsv(files['99_access_preview_GENERATED.csv']!);
  return table.rows.map((r) => key(r.values as unknown as AccessRow)).sort();
}

async function tenantCount(c: PoolClient, code: string): Promise<number> {
  return (
    await c.query<{ n: number }>(`select count(*)::int n from core.tenant where code = $1`, [code])
  ).rows[0]!.n;
}

describe.each(CUSTOMERS)('loading %s', (customer) => {
  const files = readCustomerDir(join(DATA, customer));

  it('gives every person exactly the access in the generated preview', async () => {
    await inRolledBackTx(async (c) => {
      const r = await loadCustomer(c, files, { nested: true });
      expect(r.issues).toEqual([]);
      expect(r.applied).toBe(true);
      expect(preview(customer).length).toBeGreaterThan(10);
      expect(r.access.map(key).sort()).toEqual(preview(customer));
    });
  });

  it('a dry run reports the same and changes nothing; a second load changes nothing', async () => {
    await inRolledBackTx(async (c) => {
      const code = files['00_customer.csv']!.split('\n')[1]!.split(',')[0]!;
      const before = await tenantCount(c, code);
      const dry = await loadCustomer(c, files, { nested: true, dryRun: true });
      expect(dry).toMatchObject({ ok: true, applied: false, issues: [] });
      expect(dry.access.map(key).sort()).toEqual(preview(customer));
      expect(await tenantCount(c, code)).toBe(before);

      await loadCustomer(c, files, { nested: true });
      const again = await loadCustomer(c, files, { nested: true });
      expect(again.ok).toBe(true);
      const changed = Object.entries(again.counts).filter(
        ([, n]) => n.created !== 0 || n.updated !== 0,
      );
      expect(changed).toEqual([]);
      expect(again.counts['users']!.unchanged).toBeGreaterThan(0);
    });
  });
});

describe('the prep list (file 32) after the past week was loaded on an earlier day', () => {
  // production loaded files 26 to 28 before file 32 existed (ADR 020)
  it('is created from that day and linked to the batches already there', async () => {
    await inRolledBackTx(async (c) => {
      const tenant = (
        await c.query<{ id: string }>(`select id from core.tenant where code = 'TEST-COMPANY'`)
      ).rows[0]!.id;
      // as if files 26 to 28 had been loaded two days ago, and file 32 never
      await c.query(
        `update inv.production
            set task_id = null,
                idempotency_key = regexp_replace(idempotency_key, '^test-data (\\S+)',
                  'test-data ' || ((split_part(idempotency_key, ' ', 2))::date - 2)::text)
          where tenant_id = $1 and idempotency_key like 'test-data %'`,
        [tenant],
      );
      await c.query(
        `delete from ops.task_step where task_id in
           (select id from ops.task where tenant_id = $1 and kind = 'prep')`,
        [tenant],
      );
      await c.query(`delete from ops.task where tenant_id = $1 and kind = 'prep'`, [tenant]);

      const files = readCustomerDir(join(DATA, 'test-company'));
      const r = await loadCustomer(c, files, { nested: true });
      expect(r.issues).toEqual([]);
      // four at the outlets and two at the central kitchen (ADR 030)
      expect(r.counts['prep tasks']).toMatchObject({ created: 6, unchanged: 0 });
      const { rows } = await c.query<{
        title: string;
        status: string;
        batches: number;
        days: number;
      }>(
        `select t.title, t.status,
                (select count(*)::int from inv.production p where p.task_id = t.id) as batches,
                (now()::date - (t.due_at at time zone 'Asia/Kolkata')::date) as days
           from ops.task t
          where t.tenant_id = $1 and t.kind = 'prep'
            and t.delivery_node_id <> (select id from core.hierarchy_node
                                        where code = 'TEST-CENTRAL-KITCHEN-STORE')
          order by t.due_at`,
        [tenant],
      );
      // the open one was for the load day: two days ago now
      expect(rows.map((t) => [t.title, t.status, t.batches])).toEqual([
        ['Make Mint Chutney 500 g', 'done', 1],
        ['Make Ginger Garlic Paste 1000 g', 'done', 1],
        ['Make Negroni (pre-batched) 2000 ml', 'done', 1],
        ['Make Mint Chutney 1000 g', 'open', 0],
      ]);
      expect(rows[3]!.days).toBe(2);
      const again = await loadCustomer(c, files, { nested: true });
      expect(again.counts['prep tasks']).toMatchObject({ created: 0, unchanged: 6 });
    });
  });
});

describe('rows for a store new to files 26 and 32, after the past week was loaded', () => {
  // production loaded files 26 to 32 before the central kitchen's rows existed (ADR 030)
  it('are loaded from today; the other stores keep their day; a second load changes nothing', async () => {
    await inRolledBackTx(async (c) => {
      const tenant = (
        await c.query<{ id: string }>(`select id from core.tenant where code = 'TEST-COMPANY'`)
      ).rows[0]!.id;
      // as if the outlets' batches had been loaded ten days ago, and the kitchen's never
      await c.query(
        `update inv.production
            set idempotency_key = case
                  when idempotency_key like '% TEST-CENTRAL-KITCHEN-STORE %'
                    then 'earlier ' || idempotency_key
                  else regexp_replace(idempotency_key, '^test-data (\\S+)',
                         'test-data ' || ((split_part(idempotency_key, ' ', 2))::date - 10)::text)
                end
          where tenant_id = $1 and idempotency_key like 'test-data %'`,
        [tenant],
      );
      const kitchenTasks = `select id from ops.task where tenant_id = $1 and kind = 'prep'
                               and idempotency_key like 'test-data prep TEST-CENTRAL-KITCHEN-STORE %'`;
      await c.query(`update inv.production set task_id = null where task_id in (${kitchenTasks})`, [
        tenant,
      ]);
      await c.query(`delete from ops.task_step where task_id in (${kitchenTasks})`, [tenant]);
      await c.query(`delete from ops.task where id in (${kitchenTasks})`, [tenant]);

      const files = readCustomerDir(join(DATA, 'test-company'));
      const r = await loadCustomer(c, files, { nested: true });
      expect(r.issues).toEqual([]);
      expect(r.counts['production batches']).toMatchObject({ created: 2 });
      expect(r.counts['prep tasks']).toMatchObject({ created: 2 });
      const { rows } = await c.query<{ k: string; linked: boolean }>(
        `select idempotency_key as k, task_id is not null as linked from inv.production
          where tenant_id = $1 and idempotency_key like 'test-data % TEST-CENTRAL-KITCHEN-STORE %'
          order by 1`,
        [tenant],
      );
      // file 26: days -2 and -1 from today, each made against its prep list
      const day = async (n: number) =>
        (await c.query<{ d: string }>(`select (current_date + $1::int)::text as d`, [n])).rows[0]!
          .d;
      expect(rows.map((x) => [x.k.split(' ')[1], x.linked])).toEqual([
        [await day(-2), true],
        [await day(-1), true],
      ]);

      const again = await loadCustomer(c, files, { nested: true });
      const changed = Object.entries(again.counts).filter(
        ([, n]) => n.created !== 0 || n.updated !== 0,
      );
      expect(changed).toEqual([]);
    });
  });
});
