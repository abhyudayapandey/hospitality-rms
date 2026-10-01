import { join } from 'node:path';
import { closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCustomer, type AccessRow } from './apply';
import { parseCsv } from './csv';
import { readCustomerDir } from './dir';

// The onboarding loader (ADR 009) against the two test customers in
// docs/onboarding/test-data: the access it produces is exactly each customer's generated
// preview, a dry run changes nothing, a second load changes nothing, and problems are
// reported by file, row and column.

afterAll(closePools);

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

describe('loader errors', () => {
  const base = readCustomerDir(join(DATA, 'test-company'));
  const edit = (file: string, from: string, to: string) => ({
    ...base,
    [file]: base[file]!.replace(from, to),
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
          row: 27,
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
        '07_users.csv:34:job_role_code:STORE_MANAGER at TEST-HOTEL-1.0-STORES-TEAM: MAIN_STORE_REQUIRED (main_store)',
        '07_users.csv:35:job_role_code:STORE_KEEPER at TEST-HOTEL-1.0-STORES-TEAM: MAIN_STORE_REQUIRED (main_store)',
        '07_users.csv:36:job_role_code:RECEIVING_CLERK at TEST-HOTEL-1.0-STORES-TEAM: MAIN_STORE_REQUIRED (main_store)',
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
      // steps (the HR step, role changes), and nobody above the bar manager
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
        row: 6,
        column: 'node_code',
        message: 'LEAVE hr_approval: nobody can approve at TEST-SOLO-BAR-KITCHEN (NO_APPROVER)',
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
        'test.solo.bar-manager: LEAVE (hr_approval, manager_approval) at TEST-SOLO-BAR ' +
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
        'test.account-owner: LEAVE (manager_approval) at TEST-COMPANY has no approver but them: ' +
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
      // the central kitchen chef's STOCK_USER without "(this store only)"
      const files = {
        ...company,
        '06_job_roles.csv': company['06_job_roles.csv']!.replace(
          'STOCK_USER@central_kitchen_store(this store only)',
          'STOCK_USER@central_kitchen_store',
        ),
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
