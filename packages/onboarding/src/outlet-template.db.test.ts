import { join } from 'node:path';
import { TILES, type ExtraCode } from '@outlet-ops/domain';
import { closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadCustomer, type AccessRow } from './apply';
import { readCustomerDir } from './dir';
import { addOutlet, TemplateError, type OutletChoice } from './outlet-template';

// An outlet from a template (ADR 062): every kind of outlet, with its default extras and with
// everything it offers, is added to Test Company's files and loads with no issues; nobody's
// access changes (it has no people yet); every role it expects would get access that resolves
// there; its starter checklists have rounds, each remembering the library version it came from.

afterAll(closePools);
vi.setConfig({ testTimeout: 600_000 });

const DATA = join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding', 'test-data');
const company = readCustomerDir(join(DATA, 'test-company'));
const key = (r: AccessRow) => [r.username, r.access_group, r.node_code, r.covers].join(' | ');

const choice = (tile: string, extras: readonly ExtraCode[]): OutletChoice => ({
  tile,
  extras,
  code: `NEW-${tile.toUpperCase().replace(/_/g, '-')}`,
  name: `New ${tile}`,
  parentCode: 'TEST-AREA-MUMBAI',
  timezone: 'Asia/Kolkata',
});

async function check(c: PoolClient, ch: OutletChoice, base: AccessRow[]) {
  const { files, plan } = addOutlet(company, ch);
  const r = await loadCustomer(c, files, { nested: true });
  expect(r.issues, ch.tile).toEqual([]);
  expect(r.access.map(key).sort(), `${ch.tile}: nobody's access changes`).toEqual(
    base.map(key).sort(),
  );
  // every role the outlet expects resolves at its department there (or the outlet)
  const { rows: bad } = await c.query<{ role: string; error: string }>(
    `select x.role, d.error
       from jsonb_to_recordset($1) as x(role text, place text)
       join core.hierarchy_node n on n.code = x.place
                                 and n.tenant_id = (select id from core.tenant where code = 'TEST-COMPANY')
       cross join lateral core.derive_job_role_access_at(n.tenant_id, x.role, n.id) d
      where d.error is not null`,
    [
      JSON.stringify(
        plan.roles.map((x) => ({
          role: x.code,
          place: x.department.startsWith('(') ? ch.code : `${ch.code}-${x.department}`,
        })),
      ),
    ],
  );
  expect(bad, ch.tile).toEqual([]);
  // starter checklists: one per library checklist, each with its source, and rounds
  const { rows: lists } = await c.query<{ library_code: string; library_version: number }>(
    `select t.library_code, t.library_version from ops.checklist_template t
       join core.hierarchy_node n on n.id = t.org_node_id
      where n.code like $1 || '-%' and t.archived_at is null order by 1`,
    [ch.code],
  );
  expect(
    lists.map((l) => l.library_code),
    ch.tile,
  ).toEqual(plan.checklists.map((x) => x.code).sort());
  expect(lists.every((l) => l.library_version === 1)).toBe(true);
  await c.query('select * from ops.tasks_tick(now())');
  const { rows: rounds } = await c.query<{ n: number }>(
    `select count(*)::int n from ops.task t join core.hierarchy_node n on n.id = t.org_node_id
      where n.code like $1 || '-%' and t.kind = 'checklist'`,
    [ch.code],
  );
  expect(rounds[0]!.n, ch.tile).toBeGreaterThan(0);
  return plan;
}

describe('an outlet from a template', () => {
  it('every kind of outlet loads, with its default extras and with all it offers', async () => {
    await inRolledBackTx(async (c) => {
      const base = await loadCustomer(c, company, { nested: true });
      expect(base.issues).toEqual([]);
      for (const tile of TILES) {
        await c.query('savepoint tile');
        await check(c, choice(tile.code, tile.with ?? []), base.access);
        await c.query('rollback to savepoint tile');
        await c.query('savepoint tile');
        await check(c, choice(tile.code, tile.offers), base.access);
        await c.query('rollback to savepoint tile');
      }
    });
  });

  it('a café and a restaurant come from one template: the café has a counter, no dining room', async () => {
    await inRolledBackTx(async (c) => {
      const base = await loadCustomer(c, company, { nested: true });
      const cafe = await check(c, choice('cafe', []), base.access);
      expect(cafe.departments.map((d) => d.code)).toEqual(['KITCHEN', 'COUNTER']);
      expect(cafe.roles.map((r) => r.code)).toContain('BARISTA');
      expect(cafe.roles.map((r) => r.code)).not.toContain('CAPTAIN');
    });
  });

  it('a second load of the same files changes nothing', async () => {
    await inRolledBackTx(async (c) => {
      const { files } = addOutlet(company, choice('bar_pub', ['brewery']));
      expect((await loadCustomer(c, files, { nested: true })).issues).toEqual([]);
      const again = await loadCustomer(c, files, { nested: true });
      for (const [entity, n] of Object.entries(again.counts)) {
        expect(n.created + n.updated, entity).toBe(0);
      }
    });
  });
});

describe('the plan decides what is on, never a template (ADR 067)', () => {
  it("adding an outlet switches no module on; the dry run names the bundle it uses that isn't on", async () => {
    await inRolledBackTx(async (c) => {
      const { files } = addOutlet(company, choice('cafe', []));
      const file00 = (f: Record<string, string>) =>
        f[Object.keys(f).find((k) => k.split('/').pop()!.startsWith('00_'))!];
      expect(file00(files)).toBe(file00(company));

      await c.query(
        `update core.tenant set settings = settings || '{"bundles": {"tasks_food_safety": false}}'
          where code = 'TEST-COMPANY'`,
      );
      const r = await loadCustomer(c, files, { nested: true, dryRun: true });
      expect(r.issues).toEqual([]);
      const notes = r.warnings.filter((w) => /isn't on for this customer/.test(w.message));
      expect(notes.map((w) => [w.file, w.column, w.message])).toEqual([
        [
          '01_org_nodes.csv',
          'outlet_format',
          "New cafe uses Checklists and Maintenance, part of Tasks & food safety, which isn't on for this customer",
        ],
      ]);
      expect(notes[0]!.row).toBeGreaterThan(0);
      // the outlets already there say nothing
      const again = await loadCustomer(c, company, { nested: true, dryRun: true });
      expect(again.warnings.filter((w) => /isn't on/.test(w.message))).toEqual([]);
    });
  });
});

describe('what an outlet from a template refuses', () => {
  it('says so in plain words', () => {
    expect(() => addOutlet(company, { ...choice('cafe', []), code: 'TEST-BAR-3.0' })).toThrow(
      'The code TEST-BAR-3.0 is already used: pick another outlet code',
    );
    expect(() => addOutlet(company, choice('cafe', ['brewery']))).toThrow(
      '"Brews its own beer" is not offered for Café',
    );
    expect(() => addOutlet(company, { ...choice('qsr', []), parentCode: 'NOWHERE' })).toThrow(
      'NOWHERE is not a place of this customer',
    );
    expect(() => addOutlet(company, choice('nightclub', []))).toThrow(TemplateError);
  });
});
