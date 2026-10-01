import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actAs,
  closePools,
  inRolledBackTx,
  installSubjectFixture,
  loadSeedIds,
  resetRole,
  type SeedIds,
} from '../test/helpers';
import { newWorker, workerFor } from '../test/workforce';

// ADR 007: generated policies test membership in a per-query node set
// (core.visible_nodes / core.visible_domain_nodes) instead of calling core.can() per row.
// core.can() must stay the single source of truth, so for every kind of grant and EVERY
// business table, the rows RLS returns must be exactly the rows the per-row core.can()
// expression (the pre-ADR-007 policy) selects. The users are one holder of each distinct
// grant shape (group, tree, place kind, descendants, customer) in the test customers, so
// every rule is exercised without checking all hundred-odd people. Fixtures add SELF,
// derived, include_descendants and two-leg rows so each rule has rows to decide.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

interface Registration {
  table_name: string;
  domain_code: string | null;
  hierarchy_type: 'org' | 'delivery' | 'self' | null;
  node_columns: string[] | null;
  domain_column: string | null;
  owner_column: string | null;
  tenant_scoped: boolean;
  catalog: boolean;
  has_owner_user_id: boolean;
  has_wf: boolean;
  /** rule-visible rows (recipes, ADR 014): the per-row rule and the column it takes */
  visible_row_fn: string | null;
  visible_column: string | null;
}

/**
 * The policy expression as generated before ADR 007: core.can() per row, per leg; plus,
 * for subject tables, the pending-inbox leg (ADR 009): a request's approver reads it.
 */
function perRowCan(r: Registration, access: 'view' | 'modify'): string {
  const legs = perRowLegs(r, access);
  return r.has_wf && access === 'view'
    ? `((${legs}) or wf_request_id = any ((select wf.my_actionable_requests())::uuid[]))`
    : legs;
}

function perRowLegs(r: Registration, access: 'view' | 'modify'): string {
  if (r.visible_row_fn) {
    return `tenant_id = core.my_tenant() and ${r.visible_row_fn}(${r.visible_column})`;
  }
  const owner = r.owner_column ?? (r.has_owner_user_id ? 'owner_user_id' : null);
  const o = owner ?? 'null';
  if (r.domain_column) {
    return `core.can(${r.domain_column}, '${access}', org_node_id, delivery_node_id, ${o})`;
  }
  const dom = `'${r.domain_code}'`;
  if (r.tenant_scoped) return `core.can(${dom}, '${access}', core.org_root(tenant_id), null, ${o})`;
  const cols =
    r.node_columns ??
    (r.hierarchy_type === 'org'
      ? ['org_node_id']
      : r.hierarchy_type === 'delivery'
        ? ['delivery_node_id']
        : []);
  if (cols.length === 0) return `core.can(${dom}, '${access}', null, null, ${o})`;
  return cols
    .map((c) =>
      r.hierarchy_type === 'org'
        ? `core.can(${dom}, '${access}', ${c}, null, ${o})`
        : `core.can(${dom}, '${access}', null, ${c}, ${o})`,
    )
    .join(' or ');
}

async function registrations(c: PoolClient): Promise<Registration[]> {
  const { rows } = await c.query<Registration>(
    `select dt.table_name::text as table_name, dt.domain_code, dt.hierarchy_type, dt.node_columns,
            dt.domain_column, dt.owner_column, dt.tenant_scoped, dt.catalog,
            core.has_column(dt.table_name, 'owner_user_id') as has_owner_user_id,
            core.has_column(dt.table_name, 'wf_request_id') as has_wf,
            (dt.visible_row_fn::oid)::regproc::text as visible_row_fn, dt.visible_column
       from core.domain_table dt
       join pg_class cl on cl.oid = dt.table_name
       join pg_namespace n on n.oid = cl.relnamespace
      where n.nspname in ('hr', 'inv', 'ops', 'wf', 'ai', 'menu')
      order by 1`,
  );
  return rows;
}

// RLS_ALL_USERS=1 checks every user of every customer instead of one per grant shape: slow,
// run by the manual "RLS equivalence (all users)" workflow before the pilot and whenever
// access rules change.
const ALL_USERS = process.env.RLS_ALL_USERS === '1';
const SLOW = ALL_USERS ? 3_600_000 : 300_000;

/** One holder of every distinct grant shape, plus a user with no grants at all. */
async function userIds(c: PoolClient): Promise<{ id: string; name: string }[]> {
  if (ALL_USERS) {
    const { rows } = await c.query<{ id: string; name: string }>(
      'select id, display_name as name from core.app_user order by display_name, id',
    );
    return rows;
  }
  const { rows } = await c.query<{ id: string; name: string }>(
    `with shapes as (
       select distinct on (g.code, n.type, n.kind, ra.include_descendants, u.tenant_id)
              u.id, u.display_name as name
         from core.role_assignment ra
         join core.app_user u on u.id = ra.user_id
         join core.security_group g on g.id = ra.group_id
         join core.hierarchy_node n on n.id = ra.node_id
        order by g.code, n.type, n.kind, ra.include_descendants, u.tenant_id, u.id)
     select distinct id, name from shapes
     union
     select id, display_name from core.app_user u
      where not exists (select 1 from core.role_assignment ra where ra.user_id = u.id)
     union
     -- the approver of the fixtures' pending leave (department head of Floor Service)
     select id, display_name from core.app_user where username = 'test.floor-manager.3.0'
     order by name`,
  );
  return rows;
}

/** Extra rows so SELF, derived, include_descendants and two-leg rules all apply. */
async function fixtures(c: PoolClient): Promise<void> {
  const tenant = (
    await c.query<{ t: string }>('select tenant_id as t from core.hierarchy_node where id = $1', [
      ids.node('TEST-COMPANY'),
    ])
  ).rows[0]!.t;
  // SELF: Sam's own LEAVE request (org tree, owner = initiator).
  const subject = await installSubjectFixture(c, ['hr.leave_request']);
  const leave = await subject({ org: ids.node('TEST-BAR-3.0-FLOOR-SERVICE') });
  await actAs(c, 'app_rw', ids.user('test.server.3.0'));
  await c.query(`select wf.submit('LEAVE', 'hr.leave_request', $1)`, [leave]);
  await resetRole(c);
  // Transfers: Hub -> Outlet B (hub manager sees the from leg without descendants) and
  // Outlet A -> Outlet B (outside the hub manager's TRANSFERS grant).
  const item = (
    await c.query<{ id: string }>(
      `insert into inv.item (tenant_id, sku, name, category, base_uom)
       values ($1, 'EQ-ITEM', 'Eq item', 'Test', 'kg') returning id`,
      [tenant],
    )
  ).rows[0]!.id;
  for (const [from, to] of [
    ['TEST-CENTRAL-KITCHEN-STORE', 'TEST-GUEST-HOUSE-2.0-SUPPLY'],
    ['TEST-BAR-3.0-KITCHEN-STORE', 'TEST-GUEST-HOUSE-2.0-SUPPLY'],
  ] as const) {
    const t = (
      await c.query<{ id: string }>(
        `insert into inv.transfer (tenant_id, from_node_id, to_node_id) values ($1, $2, $3)
         returning id`,
        [tenant, ids.node(from), ids.node(to)],
      )
    ).rows[0]!.id;
    await c.query(
      `insert into inv.transfer_line (tenant_id, transfer_id, item_id, from_node_id, to_node_id,
                                      requested_qty) values ($1, $2, $3, $4, $5, 1)`,
      [tenant, t, item, ids.node(from), ids.node(to)],
    );
  }
  // Stock at every delivery node (derived view for the area manager covers A and B only).
  for (const n of [
    'TEST-CENTRAL-KITCHEN-STORE',
    'TEST-BAR-3.0-KITCHEN-STORE',
    'TEST-GUEST-HOUSE-2.0-SUPPLY',
  ]) {
    await c.query(
      `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                     unit_cost, ref_type) values ($1, $2, $3, 'receipt', 1, 1, 'eq')`,
      [tenant, item, ids.node(n)],
    );
  }
  // Workforce rows at both outlets and the hub site, owned by seeded users (SELF legs).
  const workers = [
    await workerFor(c, ids, 'test.server.3.0', 'TEST-BAR-3.0-FLOOR-SERVICE', 'SERVER'),
    await workerFor(c, ids, 'test.bar-manager.3.0', 'TEST-BAR-3.0-FLOOR-SERVICE', 'MANAGER'),
    (await newWorker(c, ids, 'Eq Outlet B', 'TEST-GUEST-HOUSE-2.0', 'SERVER')).workerId,
    (await newWorker(c, ids, 'Eq Hub', 'TEST-CENTRAL-KITCHEN', 'STORE')).workerId,
  ];
  await c.query(
    `insert into hr.leave_type (tenant_id, code, name, annual_days)
     values ($1, 'EQ_LEAVE', 'Eq leave', 10) on conflict do nothing`,
    [tenant],
  );
  for (const w of workers) {
    await c.query(
      `with w as (select * from hr.worker where id = $1),
       s as (insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at, role_code)
             select tenant_id, org_node_id, date '2026-12-01', timestamptz '2026-12-01 03:30Z',
                    timestamptz '2026-12-01 11:30Z', role_code from w returning *),
       a as (insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id,
                                              org_node_id, start_at, end_at)
             select s.tenant_id, s.id, w.id, w.owner_user_id, s.org_node_id, s.start_at, s.end_at
               from s, w returning *),
       att as (insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id,
                                          shift_id, clock_in_at, in_source, in_key)
               select w.tenant_id, w.id, w.owner_user_id, w.org_node_id, s.id, s.start_at,
                      'online', 'eq' from w, s returning *),
       ex as (insert into hr.attendance_exception (tenant_id, org_node_id, worker_id,
                                                   owner_user_id, attendance_id, local_date, kind)
              select tenant_id, org_node_id, worker_id, owner_user_id, id, date '2026-12-01',
                     'late' from att returning 1),
       lb as (insert into hr.leave_balance (tenant_id, worker_id, owner_user_id, org_node_id,
                                            leave_type_id, year, entitled_days)
              select w.tenant_id, w.id, w.owner_user_id, w.org_node_id, t.id, 2026, 10
                from w, hr.leave_type t where t.code = 'EQ_LEAVE' and t.tenant_id = w.tenant_id
              returning 1),
       lr as (insert into hr.leave_request (tenant_id, worker_id, owner_user_id, org_node_id,
                                            leave_type_id, from_date, to_date, days)
              select w.tenant_id, w.id, w.owner_user_id, w.org_node_id, t.id,
                     date '2026-12-10', date '2026-12-10', 1
                from w, hr.leave_type t where t.code = 'EQ_LEAVE' and t.tenant_id = w.tenant_id
              returning 1),
       ev as (insert into ops.event (tenant_id, org_node_id, name, starts_at, ends_at, covers)
              select tenant_id, org_node_id, 'Eq event', timestamptz '2026-12-05 12:00Z',
                     timestamptz '2026-12-05 16:00Z', 40 from w returning 1)
       select ops.notify(w.tenant_id, w.owner_user_id, 'eq', 'Eq') from w`,
      [w],
    );
  }
}

describe('ADR 007 policies are equivalent to per-row core.can()', () => {
  // users x tables x a query each: slow by design, so it gets its own time limit
  it(
    'select: every seeded user sees exactly the rows core.can() allows, in every business table',
    { timeout: SLOW },
    async () => {
      await inRolledBackTx(async (c) => {
        await fixtures(c);
        // rule-visible recipe tables have their own test below; the event tables (a rule
        // over their place, ADR 016) are compared here with the rest
        const regs = (await registrations(c)).filter(
          (r) => !r.catalog && (!r.visible_row_fn || r.table_name.startsWith('ops.')),
        );
        const users = await userIds(c);
        expect(regs.length).toBeGreaterThan(15);
        let visible = 0;
        const mismatches: string[] = [];

        for (const reg of regs) {
          for (const u of users) {
            // expected: migrator (no RLS) filtering with the old per-row expression
            await c.query(`select set_config('app.user_id', $1, true)`, [u.id]);
            const expected = await c.query<{ id: string }>(
              `select id from ${reg.table_name} where ${perRowCan(reg, 'view')} order by id`,
            );
            await c.query(`select set_config('app.user_id', '', true)`);
            // actual: the generated policies, as app_rw
            await actAs(c, 'app_rw', u.id);
            const actual = await c.query<{ id: string }>(
              `select id from ${reg.table_name} order by id`,
            );
            await resetRole(c);
            const e = expected.rows.map((r) => r.id);
            const a = actual.rows.map((r) => r.id);
            visible += a.length;
            if (JSON.stringify(e) !== JSON.stringify(a)) {
              mismatches.push(
                `${reg.table_name} as ${u.name}: expected ${e.length}, got ${a.length}`,
              );
            }
          }
        }
        expect(mismatches).toEqual([]);
        expect(visible).toBeGreaterThan(100); // the comparison had real rows to compare
      });
    },
  );

  it(
    'rule-visible tables (recipes, ADR 014): the per-query id sets equal the per-row rule',
    { timeout: SLOW },
    async () => {
      await inRolledBackTx(async (c) => {
        const domains = ['RECIPES', 'RECIPES_TEAM', 'MENU', 'DERIVED_MENU'];
        // one user per shape of recipe and menu grant (domain, place kind, descendants,
        // access, customer), plus the people the menu security tests name
        const { rows: users } = await c.query<{ id: string; name: string }>(
          `select distinct on (sig) id, name from (
             select u.id, u.display_name as name, u.tenant_id::text || ' ' || coalesce(string_agg(
                      ea.domain || ':' || n.kind || ':' || ea.include_descendants || ':' || ea.access,
                      ',' order by ea.domain, n.kind, ea.access), '') as sig
               from core.app_user u
               left join core.effective_access ea on ea.user_id = u.id and ea.domain = any ($1)
               left join core.hierarchy_node n on n.tenant_id = u.tenant_id and n.path::text = ea.path::text
              group by u.id) x
           union
           select id, display_name from core.app_user where username = any ($2)
            order by 1`,
          [
            domains,
            [
              'test.bartender.1.0',
              'test.commis.1.0',
              'test.room-attendant.2.0',
              'test.cook.2.0',
              'test.executive-chef.1.0',
              'test.bar-manager.1.0',
              'test.general-manager.1.0',
              'test.solo.bar-manager',
            ],
          ],
        );
        const sample = ALL_USERS
          ? (
              await c.query<{ id: string; name: string }>(
                'select id, display_name as name from core.app_user',
              )
            ).rows
          : users;
        expect(sample.length).toBeGreaterThan(5);
        const mismatches: string[] = [];
        let visible = 0;
        for (const u of sample) {
          await c.query(`select set_config('app.user_id', $1, true)`, [u.id]);
          const ids = async (sql: string, params: unknown[] = []) =>
            (await c.query<{ id: string }>(sql, params)).rows.map((r) => r.id).sort();
          const recipes = await ids(
            `select id from inv.recipe where tenant_id = core.my_tenant() and inv.can_read_recipe(id)`,
          );
          const expected: Record<string, string[]> = {
            'inv.recipe': recipes,
            'inv.recipe_line': await ids(
              `select id from inv.recipe_line where recipe_id = any ($1::uuid[])`,
              [recipes],
            ),
            'inv.prep_procedure': await ids(
              `select p.id from inv.prep_procedure p
                where p.tenant_id = core.my_tenant()
                  and p.prep_item_id in (select x from (select distinct prep_item_id as x
                                                          from inv.prep_procedure) d
                                          where inv.can_read_prep(x))`,
            ),
            'menu.menu_item': await ids(
              `select id from menu.menu_item
                where tenant_id = core.my_tenant() and menu.can_read_menu_item(id)`,
            ),
          };
          await c.query(`select set_config('app.user_id', '', true)`);
          await actAs(c, 'app_rw', u.id);
          for (const [table, want] of Object.entries(expected)) {
            const got = await ids(`select id from ${table}`);
            visible += got.length;
            if (JSON.stringify(got) !== JSON.stringify(want)) {
              mismatches.push(`${table} as ${u.name}: expected ${want.length}, got ${got.length}`);
            }
          }
          await resetRole(c);
        }
        expect(mismatches).toEqual([]);
        expect(visible).toBeGreaterThan(100);
      });
    },
  );

  it(
    'covers SELF, derived and include_descendants (the rules the set must reproduce)',
    { timeout: 60_000 },
    async () => {
      await inRolledBackTx(async (c) => {
        await fixtures(c);
        const count = async (who: string, sql: string, params: unknown[] = []) => {
          await actAs(c, 'app_rw', ids.user(who));
          const r = await c.query<{ n: string }>(sql, params);
          await resetRole(c);
          return Number(r.rows[0]!.n);
        };
        // SELF: Sam holds no LEAVE grant, only SELF modify on his own request
        expect(
          await count(
            'test.server.3.0',
            `select count(*) as n from wf.request where process_type = 'LEAVE'`,
          ),
        ).toBeGreaterThan(0);
        // derived: the area manager sees every stocked place in the area through DERIVED_
        // (4 + 4 hotel stores, the Guest House, 2 bar stores, the central kitchen store)
        const stockNodes = `select count(distinct delivery_node_id) as n from inv.stock_level`;
        expect(await count('test.area-manager', stockNodes)).toBe(12);
        // include_descendants: SUPPLY_VIEWER at the hub (with descendants) sees them all too...
        expect(await count('test.central-kitchen-manager', stockNodes)).toBe(12);
        // ...a department's store keeper only their store
        expect(await count('test.bar-manager.1.0', stockNodes)).toBe(1);
        // ...while HUB_MANAGER's TRANSFERS grant (without descendants) sees only hub legs
        const hubLeg = `select count(*) as n from inv.transfer
                       where from_node_id <> $1 and to_node_id <> $1`;
        expect(
          await count('test.central-kitchen-manager', hubLeg, [
            ids.node('TEST-CENTRAL-KITCHEN-STORE'),
          ]),
        ).toBe(0);
      });
    },
  );

  it(
    'insert/update checks match core.can(modify), including SELF owners',
    { timeout: SLOW },
    async () => {
      await inRolledBackTx(async (c) => {
        // A writable fixture table (no business table is writable by app_rw today).
        await c.query(`create table hr.zz_eq (
        id uuid primary key default core.uuid_v7(), tenant_id uuid not null,
        org_node_id uuid not null, owner_user_id uuid)`);
        await c.query(`insert into core.domain_table (table_name, domain_code, hierarchy_type)
                     values ('hr.zz_eq', 'LEAVE', 'org')`);
        await c.query(`select core.apply_domain_rls('hr.zz_eq')`);
        await c.query(`select audit.enable('hr.zz_eq')`);
        const policy = await c.query<{ check: string }>(
          `select pg_get_expr(polwithcheck, polrelid) as check from pg_policy
          where polrelid = 'hr.zz_eq'::regclass and polname = 'dom_insert_org_node_id'`,
        );
        expect(policy.rows[0]!.check).toContain('visible_nodes');

        // a place of each kind in both customers, including a department and a site
        const nodes = (
          await c.query<{ id: string; tenant_id: string }>(
            `select id, tenant_id from core.hierarchy_node
            where type = 'org' and code in ('TEST-COMPANY', 'TEST-AREA-MUMBAI', 'TEST-HOTEL-1.0',
                  'TEST-HOTEL-1.0-KITCHEN', 'TEST-GUEST-HOUSE-2.0', 'TEST-BAR-3.0-FLOOR-SERVICE',
                  'TEST-CENTRAL-KITCHEN', 'TEST-SOLO-COMPANY', 'TEST-SOLO-BAR-BAR')`,
          )
        ).rows;
        expect(nodes).toHaveLength(9);
        const mismatches: string[] = [];
        for (const u of await userIds(c)) {
          for (const n of nodes) {
            for (const owner of [null, u.id]) {
              await c.query(`select set_config('app.user_id', $1, true)`, [u.id]);
              const can = await c.query<{ ok: boolean }>(
                `select core.can('LEAVE', 'modify', $1, null, $2) as ok`,
                [n.id, owner],
              );
              await c.query(`select set_config('app.user_id', '', true)`);
              await actAs(c, 'app_rw', u.id);
              await c.query('savepoint s');
              let inserted = true;
              try {
                await c.query(
                  `insert into hr.zz_eq (tenant_id, org_node_id, owner_user_id) values ($1, $2, $3)`,
                  [n.tenant_id, n.id, owner],
                );
              } catch {
                inserted = false;
              }
              await c.query('rollback to savepoint s');
              await resetRole(c);
              if (inserted !== can.rows[0]!.ok) {
                mismatches.push(
                  `${u.name} at ${n.id} owner=${owner !== null}: can=${can.rows[0]!.ok}`,
                );
              }
            }
          }
        }
        expect(mismatches).toEqual([]);
      });
    },
  );
});
