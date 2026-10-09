import {
  BUNDLES,
  DOMAINS,
  inPlanByDefault,
  MODULE_CODES,
  moduleOfDomain,
  needsOf,
  onByDefault,
} from '@outlet-ops/domain';
import { join } from 'node:path';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds } from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadCustomer } from './apply';
import { parseCsv } from './csv';
import { readCustomerDir } from './dir';

// The onboarding loader (ADR 009), part 2: problems in the files are reported by file, row
// and column, approvers and warnings, and what the app changed since. Part 1
// (loader.db.test.ts) loads the two test customers; the parts run side by side (ADR 029, 052).

afterAll(closePools);

// Every test here loads a whole customer, up to three times. That is 7 s on a laptop, but
// 60 to 130 s on a CI worker that shares its database with another, so the 120 s default
// (a hang guard) is too tight: the loads of Test Company timed out on one run and passed on
// the next. A longer limit here, a hang is still caught.
vi.setConfig({ testTimeout: 300_000 });

const DATA = join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding', 'test-data');
const CUSTOMERS = ['test-company', 'test-solo-bar-co'] as const;

async function tenantCount(c: PoolClient, code: string): Promise<number> {
  return (
    await c.query<{ n: number }>(`select count(*)::int n from core.tenant where code = $1`, [code])
  ).rows[0]!.n;
}

describe('loader errors', () => {
  const base = readCustomerDir(join(DATA, 'test-company'));
  const edit = (file: string, from: string, to: string) => ({
    ...base,
    [file]: base[file]!.replace(from, to),
  });

  it("suppliers' phones (PO-4): a bad one is reported; a blank one keeps what was set in the app", async () => {
    await inRolledBackTx(async (c) => {
      const bad = edit('09_suppliers.csv', '+91 98200 10002', 'call the office');
      const r = await loadCustomer(c, bad, { nested: true });
      expect(r.issues).toContainEqual({
        file: '09_suppliers.csv',
        row: 3,
        column: 'contact_phone',
        message: 'must be a phone number with 8 to 15 digits',
      });
      // set in the app, then a file with no phone for that supplier
      await c.query(
        `update inv.supplier set phone = '+91 99999 00000'
          where name = 'Test Supplier – Dairy & Poultry'
            and tenant_id = (select id from core.tenant where code = 'TEST-COMPANY')`,
      );
      const blank = edit('09_suppliers.csv', ',+91 98200 10002', ',');
      const r2 = await loadCustomer(c, blank, { nested: true });
      expect(r2.issues).toEqual([]);
      expect(r2.counts['suppliers']!.updated).toBe(0);
      const { rows } = await c.query<{ phone: string }>(
        `select phone from inv.supplier where name = 'Test Supplier – Dairy & Poultry'
            and tenant_id = (select id from core.tenant where code = 'TEST-COMPANY')`,
      );
      expect(rows[0]!.phone).toBe('+91 99999 00000');
    });
  });

  it('department types (DB-2): known values, departments only; blank is other', async () => {
    await inRolledBackTx(async (c) => {
      const bad = edit(
        '01_org_nodes.csv',
        'TEST-HOTEL-1.0-KITCHEN,Test Hotel & Bar 1.0 – Kitchen,department,TEST-HOTEL-1.0,Asia/Kolkata,,kitchen',
        'TEST-HOTEL-1.0-KITCHEN,Test Hotel & Bar 1.0 – Kitchen,department,TEST-HOTEL-1.0,Asia/Kolkata,,pastry',
      );
      const r = await loadCustomer(c, bad, { nested: true });
      expect(r.issues).toContainEqual({
        file: '01_org_nodes.csv',
        row: 9,
        column: 'department_type',
        message: 'must be kitchen, service, housekeeping or other',
      });
      const outlet = edit(
        '01_org_nodes.csv',
        'TEST-HOTEL-1.0,Test Hotel & Bar 1.0,outlet,TEST-AREA-MUMBAI,Asia/Kolkata,hotel,',
        'TEST-HOTEL-1.0,Test Hotel & Bar 1.0,outlet,TEST-AREA-MUMBAI,Asia/Kolkata,hotel,service',
      );
      const r1 = await loadCustomer(c, outlet, { nested: true });
      expect(r1.issues).toContainEqual({
        file: '01_org_nodes.csv',
        row: 5,
        column: 'department_type',
        message: 'is only for departments',
      });
      const blank = edit(
        '01_org_nodes.csv',
        'TEST-HOTEL-1.0-KITCHEN,Test Hotel & Bar 1.0 – Kitchen,department,TEST-HOTEL-1.0,Asia/Kolkata,,kitchen',
        'TEST-HOTEL-1.0-KITCHEN,Test Hotel & Bar 1.0 – Kitchen,department,TEST-HOTEL-1.0,Asia/Kolkata,,',
      );
      const r2 = await loadCustomer(c, blank, { nested: true });
      expect(r2.issues).toEqual([]);
      expect(r2.counts['org places']!.updated).toBe(1);
      const { rows } = await c.query<{ department_type: string | null }>(
        `select department_type from core.hierarchy_node where code = 'TEST-HOTEL-1.0-KITCHEN'`,
      );
      expect(rows[0]!.department_type).toBeNull();
    });
  });

  it('reports bad cells and broken references by file, row and column', async () => {
    await inRolledBackTx(async (c) => {
      const files = {
        ...edit(
          '07_users.csv',
          'test.bar-manager.1.0,Test Bar Manager 1.0,BAR_MANAGER',
          'test.bar-manager.1.0,Test Bar Manager 1.0,BAR_BOSS',
        ),
        '02_delivery_nodes.csv': base['02_delivery_nodes.csv']!.replace(
          'TEST-BAR-3.0-KITCHEN-STORE,Test Bar 3.0 – Kitchen Store,store,TEST-BAR-3.0-SUPPLY,Asia/Kolkata,yes,no',
          'TEST-BAR-3.0-KITCHEN-STORE,Test Bar 3.0 – Kitchen Store,store,TEST-BAR-3.0-SUPPLY,Asia/Kolkata,maybe,no',
        ),
      };
      const r = await loadCustomer(c, files, { nested: true });
      expect(r.ok).toBe(false);
      expect(r.applied).toBe(false);
      expect(r.issues).toContainEqual({
        file: '02_delivery_nodes.csv',
        row: 17,
        column: 'holds_stock',
        message: 'must be yes or no',
      });
      // reference checks run once every file parses
      const fixed = { ...files, '02_delivery_nodes.csv': base['02_delivery_nodes.csv']! };
      const r2 = await loadCustomer(c, fixed, { nested: true });
      expect(r2.issues).toEqual([
        {
          file: '07_users.csv',
          row: 30,
          column: 'job_role_code',
          message: 'BAR_BOSS is not in 06_job_roles.csv',
        },
      ]);
    });
  });

  it('rejects stock at a place that holds none, and a missing file', async () => {
    await inRolledBackTx(async (c) => {
      const files = edit(
        '11_item_locations.csv',
        'TOMATOES,TEST-HOTEL-1.0-KITCHEN-STORE',
        'TOMATOES,TEST-HOTEL-1.0-SUPPLY',
      );
      delete (files as Record<string, string>)['03_node_links.csv'];
      const r = await loadCustomer(c, files, { nested: true });
      expect(r.issues).toEqual([{ file: '03_node_links.csv', message: 'file is missing' }]);
      files['03_node_links.csv'] = base['03_node_links.csv']!;
      const r2 = await loadCustomer(c, files, { nested: true });
      expect(r2.issues).toContainEqual({
        file: '11_item_locations.csv',
        row: 2,
        column: 'store_node_code',
        message: 'TEST-HOTEL-1.0-SUPPLY does not hold stock',
      });
    });
  });

  it('rejects an event at a department: events are for a whole outlet (ADR 016)', async () => {
    await inRolledBackTx(async (c) => {
      const files = edit(
        '17_events_TEST_DATA_ONLY.csv',
        'TEST-HOTEL-1.0,Test Wedding Reception',
        'TEST-HOTEL-1.0-BANQUETS,Test Wedding Reception',
      );
      const r = await loadCustomer(c, files, { nested: true });
      expect(r.issues).toEqual([
        {
          file: '17_events_TEST_DATA_ONLY.csv',
          row: 2,
          column: 'org_node_code',
          message: 'TEST-HOTEL-1.0-BANQUETS is a department: events are for a whole outlet',
        },
      ]);
    });
  });

  it('refuses the test-only activity files 25 to 28 and 30 to 32 for a customer that is not a test customer (ADR 017, ADR 020)', async () => {
    await inRolledBackTx(async (c) => {
      // the solo bar as a new, real customer (its own code and usernames, is_test no),
      // with one valid row in each activity file
      const solo = readCustomerDir(join(DATA, 'test-solo-bar-co'));
      const copy = Object.fromEntries(
        Object.entries(solo).map(([f, text]) => [f, text.replaceAll('test.solo.', 'real.solo.')]),
      );
      const by = 'real.solo.bar-manager';
      const files = {
        ...copy,
        '00_customer.csv':
          'customer_code,company_name,country,currency,default_timezone,is_test\r\n' +
          'REAL-SOLO,Real Solo Bar,India,INR,Asia/Kolkata,no\r\n',
        '25_shifts_TEST_DATA_ONLY.csv': `roster_node_code,shift_name,job_role_code,week,days,username,rostered_by\r\nTEST-SOLO-BAR-BAR,Bar Evening,BARTENDER,1,Mon,real.solo.bartender,${by}\r\n`,
        '26_production_TEST_DATA_ONLY.csv': `store_node_code,prep_item_code,day,time,quantity,made_by\r\nTEST-SOLO-BAR-KITCHEN-STORE,MINT-CHUTNEY,-1,10:00,500,${by}\r\n`,
        '27_sales_TEST_DATA_ONLY.csv': `outlet_code,day,menu_item_code,quantity,posted_by\r\nTEST-SOLO-BAR,-1,MASALA-FRIES,3,${by}\r\n`,
        '28_counts_TEST_DATA_ONLY.csv': `store_node_code,item_code,difference,counted_by,approved_by\r\nTEST-SOLO-BAR-KITCHEN-STORE,TOMATOES,0,${by},${by}\r\n`,
        '30_tasks_TEST_DATA_ONLY.csv': `place_code,title,description,day,due_time,priority,assign_to,steps,created_by,done_by\r\nTEST-SOLO-BAR-BAR,Polish glasses,,1,17:00,normal,role:BARTENDER,,${by},\r\n`,
        '31_maintenance_TEST_DATA_ONLY.csv': `place_code,title,description,reported_by,assigned_to,assigned_by\r\nTEST-SOLO-BAR-BAR,Tap leaking,,${by},,\r\n`,
        '32_prep_tasks_TEST_DATA_ONLY.csv': `store_node_code,prep_item_code,day,due_time,quantity,assign_to,created_by\r\nTEST-SOLO-BAR-KITCHEN-STORE,MINT-CHUTNEY,0,12:00,500,role:COOK,${by}\r\n`,
      };
      expect(files['00_customer.csv']).toContain('REAL-SOLO');
      expect(files['00_customer.csv']).toMatch(/,no\r?\n?$/);
      const before = await tenantCount(c, 'REAL-SOLO');
      const r = await loadCustomer(c, files, { nested: true });
      expect(r.applied).toBe(false);
      const refused =
        'this file is test data: only a test customer (is_test in file 00) may load it';
      expect(r.issues).toEqual([
        { file: '25_shifts_TEST_DATA_ONLY.csv', message: refused },
        { file: '26_production_TEST_DATA_ONLY.csv', message: refused },
        { file: '27_sales_TEST_DATA_ONLY.csv', message: refused },
        { file: '28_counts_TEST_DATA_ONLY.csv', message: refused },
        { file: '30_tasks_TEST_DATA_ONLY.csv', message: refused },
        { file: '31_maintenance_TEST_DATA_ONLY.csv', message: refused },
        { file: '32_prep_tasks_TEST_DATA_ONLY.csv', message: refused },
      ]);
      expect(await tenantCount(c, 'REAL-SOLO')).toBe(before);
    });
  });

  it('checks checklists (file 29): schedules, matching rows, and who they go to (ADR 020)', async () => {
    await inRolledBackTx(async (c) => {
      const file = '29_checklist_templates.csv';
      // an unreadable schedule, on the template's first row
      const r1 = await loadCustomer(
        c,
        edit(
          file,
          'Kitchen opening,daily 07:00,role:COMMIS,1,',
          'Kitchen opening,at 7am,role:COMMIS,1,',
        ),
        { nested: true },
      );
      expect(r1.issues).toContainEqual(
        expect.objectContaining({ file, row: 2, column: 'schedule' }),
      );
      // a later row of the same template that disagrees
      const r2 = await loadCustomer(
        c,
        edit(
          file,
          'Kitchen opening,daily 07:00,role:COMMIS,2,',
          'Kitchen opening,daily 08:00,role:COMMIS,2,',
        ),
        { nested: true },
      );
      expect(r2.issues).toEqual([
        {
          file,
          row: 3,
          column: 'schedule',
          message: 'differs from line 2 of HOTEL-1.0-KITCHEN-OPENING',
        },
      ]);
      // a job role nobody holds at the place is refused by the database, and nothing loads
      const r3 = await loadCustomer(
        c,
        {
          ...base,
          [file]: base[file]!.replaceAll('role:PUBLIC_AREA_ATTENDANT', 'role:TECHNICIAN'),
        },
        { nested: true },
      );
      expect(r3.applied).toBe(false);
      expect(r3.issues).toEqual([
        { file, row: 18, message: 'INVALID_ASSIGNEE: nobody in that job role works at this place' },
      ]);
    });
  });

  it('rejects job roles whose scope cannot be resolved, and writes nothing', async () => {
    await inRolledBackTx(async (c) => {
      // Hotel 1.0 without a main store: its supply point holds no stock, so main_store
      // cannot fall back
      const files = edit(
        '02_delivery_nodes.csv',
        'TEST-HOTEL-1.0-MAIN-STORE,Test Hotel & Bar 1.0 – Main Store,store,TEST-HOTEL-1.0-SUPPLY,Asia/Kolkata,yes,yes',
        'TEST-HOTEL-1.0-MAIN-STORE,Test Hotel & Bar 1.0 – Main Store,store,TEST-HOTEL-1.0-SUPPLY,Asia/Kolkata,yes,no',
      );
      const before = await tenantCount(c, 'TEST-COMPANY');
      const r = await loadCustomer(c, files, { nested: true });
      expect(r.applied).toBe(false);
      expect(r.issues.map((i) => `${i.file}:${i.row}:${i.column}:${i.message}`)).toEqual([
        '07_users.csv:38:job_role_code:PURCHASE_MANAGER at TEST-HOTEL-1.0-STORES-TEAM: MAIN_STORE_REQUIRED (main_store)',
        '07_users.csv:39:job_role_code:STORE_KEEPER at TEST-HOTEL-1.0-STORES-TEAM: MAIN_STORE_REQUIRED (main_store)',
        '07_users.csv:40:job_role_code:RECEIVING_CLERK at TEST-HOTEL-1.0-STORES-TEAM: MAIN_STORE_REQUIRED (main_store)',
      ]);
      expect(await tenantCount(c, 'TEST-COMPANY')).toBe(before);
    });
  });
});

describe('approvers (ADR 009)', () => {
  const solo = readCustomerDir(join(DATA, 'test-solo-bar-co'));

  it('rejects a structure where some process would have no approver, listing each case', async () => {
    await inRolledBackTx(async (c) => {
      // without file 08 the solo bar has no account owner: nobody approves the owner-only
      // steps (role changes), and nobody above the bar manager (leave's GM step, ADR 076)
      // (loaded as a new customer: the existing one keeps its owner, guardrail (d); with
      // its own usernames, since logins are unique across customers, ADR 011)
      const copy = Object.fromEntries(
        Object.entries(solo).map(([f, text]) => [
          f,
          text.replaceAll('test.solo.', 'test.solocopy.'),
        ]),
      );
      const files = {
        ...copy,
        '00_customer.csv': copy['00_customer.csv']!.replaceAll(
          'TEST-SOLO-COMPANY',
          'TEST-SOLO-COPY',
        ),
        '08_role_assignments_extra.csv': copy['08_role_assignments_extra.csv']!.split(/\r?\n/)[0]!,
      };
      const before = await tenantCount(c, 'TEST-SOLO-COPY');
      const r = await loadCustomer(c, files, { nested: true });
      expect(r.applied).toBe(false);
      expect(r.issues).toContainEqual({
        file: '01_org_nodes.csv',
        row: 2,
        column: 'node_code',
        message: 'LEAVE gm_approval: nobody can approve at TEST-SOLO-COMPANY (NO_APPROVER)',
      });
      expect(r.issues).toContainEqual({
        file: '01_org_nodes.csv',
        row: 2,
        column: 'node_code',
        message:
          'ROLE_CHANGE security_approval: nobody can approve at TEST-SOLO-COMPANY (NO_APPROVER)',
      });
      expect(r.issues.every((i) => i.message.endsWith('(NO_APPROVER)'))).toBe(true);
      expect(await tenantCount(c, 'TEST-SOLO-COPY')).toBe(before);
    });
  });

  it('sets the leave HR step per customer from file 00', async () => {
    await inRolledBackTx(async (c) => {
      const [head, row] = solo['00_customer.csv']!.trim().split(/\r?\n/);
      const files = {
        ...solo,
        '00_customer.csv': `${head},leave_hr_approval\n${row},no\n`,
      };
      const r = await loadCustomer(c, files, { nested: true });
      expect(r.issues).toEqual([]);
      const { rows } = await c.query<{ s: Record<string, unknown> }>(
        `select settings as s from core.tenant where code = 'TEST-SOLO-COMPANY'`,
      );
      expect(rows[0]!.s).toMatchObject({ leave_hr_approval: false });
    });
  });

  it("the blocks are the database's, in its order, with what each needs and its default (ADR 085)", async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ codes: string[] }>('select core.module_codes() as codes');
      expect(rows[0]!.codes).toEqual([...MODULE_CODES]);
      const m = await c.query<{ m: string; needs: string[]; d: boolean }>(
        `select m, core.module_needs(m) as needs, core.module_default(m) as d
           from unnest(core.module_codes()) m`,
      );
      expect(Object.fromEntries(m.rows.map((r) => [r.m, [r.needs, r.d]]))).toEqual(
        Object.fromEntries(MODULE_CODES.map((c) => [c, [[...needsOf(c)], onByDefault(c)]])),
      );
    });
  });

  it("every access domain's block is the database's; the base has none (ADR 085)", async () => {
    await inRolledBackTx(async (c) => {
      const r = await c.query<{ d: string; m: string | null }>(
        'select d, core.domain_module(d) as m from unnest($1::text[]) d',
        [DOMAINS.map((d) => d.code)],
      );
      expect(Object.fromEntries(r.rows.map((x) => [x.d, x.m]))).toEqual(
        Object.fromEntries(DOMAINS.map((d) => [d.code, moduleOfDomain(d.code)])),
      );
    });
  });

  it("the bundles, the block each sells and which are in a plan by default are the database's (ADR 067, 085)", async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ codes: string[] }>('select core.bundle_codes() as codes');
      expect(rows[0]!.codes).toEqual(BUNDLES.map((b) => b.code));
      const of = await c.query<{ m: string; b: string }>(
        'select m, core.module_bundle(m) as b from unnest(core.module_codes()) m order by m',
      );
      expect(Object.fromEntries(of.rows.map((r) => [r.m, r.b]))).toEqual(
        Object.fromEntries(BUNDLES.flatMap((b) => b.modules.map((m) => [m, b.code]))),
      );
      const d = await c.query<{ b: string; d: boolean }>(
        'select b, core.bundle_default(b) as d from unnest(core.bundle_codes()) b',
      );
      expect(Object.fromEntries(d.rows.map((r) => [r.b, r.d]))).toEqual(
        Object.fromEntries(BUNDLES.map((b) => [b.code, inPlanByDefault(b)])),
      );
    });
  });

  it('sets modules from file 00; blank keeps what the owner chose; a second load changes nothing (ADR 026)', async () => {
    await inRolledBackTx(async (c) => {
      const modules = async () =>
        (
          await c.query<{ m: Record<string, boolean> }>(
            `select settings -> 'modules' as m from core.tenant where code = 'TEST-SOLO-COMPANY'`,
          )
        ).rows[0]!.m;
      // the test data turns Events and Swaps off
      expect(await modules()).toEqual({ events: false, swaps: false });
      const [head, row] = solo['00_customer.csv']!.trim().split(/\r?\n/);
      const withMaint = { ...solo, '00_customer.csv': `${head},maintenance\n${row},no\n` };
      expect((await loadCustomer(c, withMaint, { nested: true })).issues).toEqual([]);
      expect(await modules()).toEqual({ events: false, swaps: false, maintenance: false });
      const audit = async () =>
        (
          await c.query<{ n: number }>(
            `select count(*)::int as n from audit.log where table_name = 'core.tenant'
               and row_id = (select id from core.tenant where code = 'TEST-SOLO-COMPANY')`,
          )
        ).rows[0]!.n;
      const before = await audit();
      expect((await loadCustomer(c, withMaint, { nested: true })).issues).toEqual([]);
      expect(await audit()).toBe(before);
      // a blank column leaves the module as it is
      const blank = { ...solo, '00_customer.csv': `${head},maintenance\n${row},\n` };
      expect((await loadCustomer(c, blank, { nested: true })).issues).toEqual([]);
      expect((await modules()).maintenance).toBe(false);
      const bad = { ...solo, '00_customer.csv': `${head},maintenance\n${row},maybe\n` };
      expect((await loadCustomer(c, bad, { nested: true })).issues[0]).toMatchObject({
        file: '00_customer.csv',
        column: 'maintenance',
      });
    });
  });

  it('Salaries & labour cost off in file 00: the pay rates in file 34 are not loaded, and it says so (ADR 085)', async () => {
    await inRolledBackTx(async (c) => {
      // every rate set to a marker: a load that writes rates puts the file's back
      const rates = async () =>
        (
          await c.query<{ n: number }>(
            `select count(*)::int as n from hr.worker_sensitive s
               join core.tenant t on t.id = s.tenant_id
              where t.code = 'TEST-SOLO-COMPANY' and s.pay_rate <> 1.23`,
          )
        ).rows[0]!.n;
      await c.query(
        `update hr.worker_sensitive s set pay_rate = 1.23 from core.tenant t
          where t.id = s.tenant_id and t.code = 'TEST-SOLO-COMPANY' and s.pay_rate is not null`,
      );
      const [head, row] = solo['00_customer.csv']!.trim().split(/\r?\n/);
      const noPay = { ...solo, '00_customer.csv': `${head},pay\n${row},no\n` };
      const r = await loadCustomer(c, noPay, { nested: true });
      expect(r.issues).toEqual([]);
      const payNote = r.warnings.find((w) => w.file === '34_pay_rates.csv');
      expect(payNote?.message).toMatch(
        /^Salaries & labour cost is off for this customer, so the \d+ pay rate\(s\) in this file are not loaded$/,
      );
      expect(await rates()).toBe(0);
      // back on: they load
      const withPay = { ...solo, '00_customer.csv': `${head},pay\n${row},yes\n` };
      expect((await loadCustomer(c, withPay, { nested: true })).issues).toEqual([]);
      expect(await rates()).toBeGreaterThan(0);
    });
  });
});

describe('people whose own requests nobody else could approve (ADR 010)', () => {
  it('are warnings in the dry run, not blockers: the solo owner, and the company owner’s own leave', async () => {
    await inRolledBackTx(async (c) => {
      const solo = await loadCustomer(c, readCustomerDir(join(DATA, 'test-solo-bar-co')), {
        nested: true,
        dryRun: true,
      });
      expect(solo).toMatchObject({ ok: true, issues: [] });
      const leave = solo.warnings.find((w) => w.message.includes(': LEAVE '));
      expect(leave).toMatchObject({ file: '07_users.csv', column: 'username' });
      expect(leave?.row).toBeGreaterThan(1);
      expect(leave?.message).toBe(
        'test.solo.bar-manager: LEAVE (gm_approval, manager_approval) at TEST-SOLO-BAR ' +
          'has no approver but them: approved at the top of the chain (account owner)',
      );
      expect(new Set(solo.warnings.map((w) => w.message.split(':')[0]))).toEqual(
        new Set(['test.solo.bar-manager']),
      );

      const company = await loadCustomer(c, readCustomerDir(join(DATA, 'test-company')), {
        nested: true,
        dryRun: true,
      });
      expect(company.ok).toBe(true);
      expect(company.warnings.map((w) => w.message)).toEqual([
        'test.account-owner: LEAVE (gm_approval, manager_approval) at TEST-COMPANY has no approver but them: ' +
          'approved at the top of the chain (account owner)',
        'test.account-owner: SHIFT_SWAP (manager_approval) at TEST-COMPANY has no approver ' +
          'but them: approved at the top of the chain (account owner)',
      ]);
    });
  });

  it('someone who is not an account owner would get NO_APPROVER', async () => {
    await inRolledBackTx(async (c) => {
      // the solo bar without its owner: the head cook's own requests have no one left
      await c.query('alter table core.role_assignment disable trigger last_account_owner');
      await c.query(
        `delete from core.role_assignment ra using core.app_user u
          where u.id = ra.user_id and u.username = 'test.solo.bar-manager'`,
      );
      const { rows } = await c.query<{ username: string; account_owner: boolean }>(
        `select distinct username, account_owner from wf.people_without_approver(
           (select id from core.tenant where code = 'TEST-SOLO-COMPANY'))`,
      );
      expect(rows).toContainEqual({ username: 'test.solo.head-cook', account_owner: false });
    });
  });
});

describe('stock access that reaches more than one stock location', () => {
  const reach = (w: { message: string }) => w.message.includes(' also reaches ');

  it('the shipped files raise none', async () => {
    await inRolledBackTx(async (c) => {
      for (const customer of CUSTOMERS) {
        const r = await loadCustomer(c, readCustomerDir(join(DATA, customer)), {
          nested: true,
          dryRun: true,
        });
        expect(r.ok, customer).toBe(true);
        expect(r.warnings.filter(reach), customer).toEqual([]);
      }
    });
  });

  it('is a warning naming the person and the extra stores, not a blocker', async () => {
    await inRolledBackTx(async (c) => {
      const company = readCustomerDir(join(DATA, 'test-company'));
      // the central kitchen chef's STOCK_USER given directly, without "(this store only)",
      // instead of by its duty (ADR 059)
      const lines = company['06_job_roles.csv']!.trimEnd().split('\n');
      const files = {
        ...company,
        '06_job_roles.csv':
          lines
            .map((l, i) =>
              i === 0
                ? `${l},default_access`
                : l.startsWith('CENTRAL_KITCHEN_CHEF,')
                  ? `${l.replace('USES_CENTRAL_KITCHEN_STORE; ', '')},STOCK_USER@central_kitchen_store`
                  : `${l},`,
            )
            .join('\n') + '\n',
      };
      expect(files['06_job_roles.csv']).not.toBe(company['06_job_roles.csv']);
      const r = await loadCustomer(c, files, { nested: true, dryRun: true });
      expect(r).toMatchObject({ ok: true, issues: [] });
      const users = parseCsv(company['07_users.csv']!);
      const chef = users.rows.find((u) => u.values.username === 'test.central-kitchen-chef')!;
      expect(r.warnings.filter(reach)).toEqual([
        {
          file: '07_users.csv',
          row: chef.line,
          column: 'username',
          message:
            'test.central-kitchen-chef: STOCK_USER at TEST-CENTRAL-KITCHEN-STORE also reaches ' +
            '11 other stock locations through the places below it: TEST-BAR-3.0-BAR-STORE, ' +
            'TEST-BAR-3.0-KITCHEN-STORE, TEST-GUEST-HOUSE-2.0-SUPPLY, TEST-HOTEL-1.0-BAR-STORE, ' +
            'TEST-HOTEL-1.0-HOUSEKEEPING-STORE, TEST-HOTEL-1.0-KITCHEN-STORE, ' +
            'TEST-HOTEL-1.0-MAIN-STORE, TEST-HOTEL-1.1-BAR-STORE, ' +
            'TEST-HOTEL-1.1-HOUSEKEEPING-STORE, TEST-HOTEL-1.1-KITCHEN-STORE, ' +
            'TEST-HOTEL-1.1-MAIN-STORE. Add "(this store only)" if they work at ' +
            'TEST-CENTRAL-KITCHEN-STORE only',
        },
      ]);
    });
  });
});

describe('logins are unique across customers (ADR 011)', () => {
  it('reports another customer’s username or email by file, row and column, with a suggestion', async () => {
    await inRolledBackTx(async (c) => {
      const solo = readCustomerDir(join(DATA, 'test-solo-bar-co'));
      const [head, ...rest] = solo['07_users.csv']!.trim().split(/\r?\n/);
      const files = {
        ...solo,
        '00_customer.csv': solo['00_customer.csv']!.replaceAll('TEST-SOLO-COMPANY', 'ACME'),
        '07_users.csv': [head, ...rest].join('\n'),
      };
      const r = await loadCustomer(c, files, { nested: true, dryRun: true });
      expect(r.ok).toBe(false);
      expect(r.issues).toContainEqual({
        file: '07_users.csv',
        row: 2,
        column: 'username',
        message: `${rest[0]!.split(',')[0]} is used by another customer (USERNAME_TAKEN); try acme.${rest[0]!.split(',')[0]}`,
      });
      expect(r.issues.every((i) => i.message.includes('_TAKEN'))).toBe(true);
    });
  });
});

describe('a location set in the app (file 04, ADR 018)', () => {
  const moved = (w: { message: string }) => w.message.includes('set in the app');

  it('the dry run warns, naming who changed it and when; applying puts the file back', async () => {
    await inRolledBackTx(async (c) => {
      const ids = await loadSeedIds();
      const company = readCustomerDir(join(DATA, 'test-company'));
      const gm = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        'select hr.set_place_location($1, 19.06, 72.83, 200)',
        [ids.node('TEST-HOTEL-1.0')],
      );
      expect(gm.error).toBeUndefined();
      const when = (
        await c.query<{ t: string }>(
          `select to_char(now() at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') t`,
        )
      ).rows[0]!.t;
      const row = parseCsv(company['04_location_settings.csv']!).rows.find(
        (r) => r.values.org_node_code === 'TEST-HOTEL-1.0',
      )!;

      const dry = await loadCustomer(c, company, { nested: true, dryRun: true });
      expect(dry).toMatchObject({ ok: true, issues: [] });
      expect(dry.warnings.filter(moved)).toEqual([
        {
          file: '04_location_settings.csv',
          row: row.line,
          column: 'org_node_code',
          message:
            `TEST-HOTEL-1.0: the location was set in the app by Test General Manager 1.0 on ` +
            `${when} Asia/Kolkata (19.06, 72.83, 200 m); this import replaces it with ` +
            `19.0596, 72.8295, 150 m`,
        },
      ]);

      const applied = await loadCustomer(c, company, { nested: true });
      expect(applied.warnings.filter(moved)).toHaveLength(1);
      const after = await c.query(
        `select latitude, geofence_radius_m, set_in_app_by from hr.node_setting where org_node_id = $1`,
        [ids.node('TEST-HOTEL-1.0')],
      );
      expect(after.rows).toEqual([
        { latitude: '19.059600', geofence_radius_m: 150, set_in_app_by: null },
      ]);
      const again = await loadCustomer(c, company, { nested: true, dryRun: true });
      expect(again.warnings.filter(moved)).toEqual([]);
    });
  });

  it('no warning when the app set the same values the file has', async () => {
    await inRolledBackTx(async (c) => {
      const ids = await loadSeedIds();
      await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        'select hr.set_place_location($1, 19.0596, 72.8295, 150)',
        [ids.node('TEST-HOTEL-1.0')],
      );
      const dry = await loadCustomer(c, readCustomerDir(join(DATA, 'test-company')), {
        nested: true,
        dryRun: true,
      });
      expect(dry.warnings.filter(moved)).toEqual([]);
    });
  });
});

describe('test attendance (file 35) next to sessions clocked in the app', () => {
  const skipped = (w: { message: string }) => w.message.includes('overlaps a session clocked');

  it('skips the test sessions that clash with a real one, warning per row; the rest load', async () => {
    await inRolledBackTx(async (c) => {
      const ids = await loadSeedIds();
      const company = readCustomerDir(join(DATA, 'test-company'));
      // as on production before the first load of file 35: no test sessions yet, and the
      // test commis clocked in for real three days ago and never clocked out
      await c.query(
        `delete from hr.attendance_exception where attendance_id in
           (select id from hr.attendance where in_key like 'test-data att %')`,
      );
      await c.query(`delete from hr.attendance where in_key like 'test-data att %'`);
      await c.query(
        `insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, clock_in_at,
                                    in_source, in_key)
         select w.tenant_id, w.id, w.owner_user_id, w.org_node_id,
                now() - interval '3 days', 'online', 'real clock-in'
           from hr.worker w where w.owner_user_id = $1`,
        [ids.user('test.commis.1.0')],
      );
      const rows = parseCsv(company['35_attendance_TEST_DATA_ONLY.csv']!).rows;
      const commis = rows.filter((r) => r.values.username === 'test.commis.1.0');
      const clash = commis.filter((r) => Number(r.values.day) >= -3);
      expect(clash.length).toBeGreaterThan(0);

      const dry = await loadCustomer(c, company, { nested: true, dryRun: true });
      expect(dry).toMatchObject({ ok: true, issues: [] });
      const warned = dry.warnings.filter(skipped);
      expect(warned.map((w) => w.row).sort()).toEqual(
        clash
          .map((r) => r.line)
          .filter((l) => warned.some((w) => w.row === l))
          .sort(),
      );
      expect(warned.length).toBeGreaterThan(0);
      expect(warned.every((w) => w.message.startsWith('test.commis.1.0: skipped '))).toBe(true);
      expect(dry.counts['attendance sessions']).toEqual({
        created: rows.length - warned.length,
        updated: 0,
        unchanged: 0,
      });
    });
  });
});
