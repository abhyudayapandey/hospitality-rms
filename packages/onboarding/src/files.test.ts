import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUTIES, ROLE_BY_CODE, catalogueReference } from '@outlet-ops/domain';
import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import { readCustomerDir } from './dir';
import { FILES, jobRoleAccess, readBundle } from './files';
import { validateBundle } from './validate';

// The checklist columns of file 29 (ADR 020): what the database's checks then receive.
const row = (schedule: string, assign_to = 'on_shift') =>
  FILES.checklistTemplates.schema.safeParse({
    template_code: 'K-OPEN',
    place_code: 'TEST-HOTEL-1.0-KITCHEN',
    name: 'Kitchen opening',
    schedule,
    assign_to,
    step: '1',
    step_label: 'Gas off',
    step_kind: 'tick',
    min: '',
    max: '',
    unit: '',
    photo_required: '',
  });

describe('checklist schedules', () => {
  it('reads daily, weekly and every-N-hours schedules', () => {
    expect(row('daily 07:00 22:30').data?.schedule).toEqual({
      kind: 'daily',
      times: ['07:00', '22:30'],
    });
    expect(row('weekly Thu,Mon 09:00').data?.schedule).toEqual({
      kind: 'weekly',
      weekdays: [1, 4],
      times: ['09:00'],
    });
    expect(row('every 2h 08:00-22:00').data?.schedule).toEqual({
      kind: 'every_n_hours',
      every: 2,
      from: '08:00',
      to: '22:00',
    });
    // a window past midnight
    expect(row('every 4h 22:00-02:00').data?.schedule).toMatchObject({
      from: '22:00',
      to: '02:00',
    });
  });

  it('refuses what it cannot read', () => {
    for (const bad of [
      'daily',
      'daily 7am',
      'weekly Funday 09:00',
      'every 5h 08:00-22:00',
      'hourly',
    ]) {
      expect(row(bad).success, bad).toBe(false);
    }
  });
});

describe('who a task goes to', () => {
  it('a job role, whoever is on shift, or one person', () => {
    expect(row('daily 07:00', 'role:COMMIS').data?.assign_to).toEqual({
      mode: 'job_role',
      role: 'COMMIS',
    });
    expect(row('daily 07:00', 'on_shift').data?.assign_to).toEqual({ mode: 'on_shift' });
    expect(row('daily 07:00', 'person:test.commis.1.0').data?.assign_to).toEqual({
      mode: 'person',
      username: 'test.commis.1.0',
    });
    expect(row('daily 07:00', 'commis').success).toBe(false);
  });
});

// File 06's duties (ADR 059): read, expanded to their grants, and kept in step with the README.
describe('job role duties', () => {
  const role = (default_duties: string, default_access = '') =>
    FILES.jobRoles.schema.safeParse({
      job_role_code: 'F_AND_B',
      job_title: 'F&B Manager',
      outlet_format: 'any',
      usual_department: 'RESTAURANT',
      default_duties,
      default_access,
    });

  it('expands duties to their grants, then adds direct grants', () => {
    const r = role(
      'RUNS_DEPARTMENT; RUNS_DEPARTMENT@department:BAR; RUNS_CENTRAL_KITCHEN_STORE',
      'KITCHEN_LEAD@home_department',
    );
    expect(r.success).toBe(true);
    expect(jobRoleAccess(r.data!)).toEqual([
      {
        group: 'DEPARTMENT_HEAD',
        scope: 'home_department',
        includeDescendants: true,
        duty: 'RUNS_DEPARTMENT',
      },
      {
        group: 'DEPARTMENT_HEAD',
        scope: 'department:BAR',
        includeDescendants: true,
        duty: 'RUNS_DEPARTMENT',
      },
      {
        group: 'HUB_MANAGER',
        scope: 'central_kitchen_store',
        includeDescendants: false,
        duty: 'RUNS_CENTRAL_KITCHEN_STORE',
      },
      {
        group: 'SUPPLY_VIEWER',
        scope: 'central_kitchen_store',
        includeDescendants: true,
        duty: 'RUNS_CENTRAL_KITCHEN_STORE',
      },
      { group: 'KITCHEN_LEAD', scope: 'home_department', includeDescendants: true },
    ]);
  });

  it('refuses unknown duties and duties given where they cannot be', () => {
    const messages = (v: string) => role(v).error?.issues.map((i) => i.message);
    expect(messages('RUNS_OUTLETS')).toEqual(['RUNS_OUTLETS is not a duty']);
    expect(messages('WORKS_SHIFTS@department:BAR')).toEqual([
      'WORKS_SHIFTS cannot be given at another department',
    ]);
    expect(messages('RUNS_DEPARTMENT@whole_outlet')).toEqual([
      '"RUNS_DEPARTMENT@whole_outlet" is not DUTY or DUTY@department:CODE',
    ]);
  });

  it('the onboarding README lists every duty with what it stands for', () => {
    const readme = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding', 'test-data', 'README.md'),
      'utf8',
    );
    for (const d of DUTIES) {
      const line = readme.split('\n').find((l) => l.startsWith(`| \`${d.code}\``));
      expect(line, d.code).toBeDefined();
      for (const g of d.grants) {
        expect(line).toContain(
          `${g.group}@${g.scope}${g.thisPlaceOnly ? '(this store only)' : ''}`,
        );
      }
    }
  });
});

// The role catalogue in file 06 (ADR 060): a catalogue role may be listed by its code alone,
// a filled-in row is used as written, and the test customers differ from the catalogue only
// where listed here.
describe('job roles from the catalogue', () => {
  const DATA = join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding', 'test-data');
  const read = (rows: string) => {
    const { bundle, issues } = readBundle({
      '06_job_roles.csv': `job_role_code,job_title,outlet_format,usual_department,default_duties\n${rows}\n`,
    });
    return { roles: bundle.jobRoles, issues: issues.filter((i) => i.file === '06_job_roles.csv') };
  };

  it('fills a blank row from the catalogue, its other formats included', () => {
    const { roles, issues } = read('SOUS_CHEF,,any,,\nBAR_MANAGER,,any,,');
    expect(issues).toEqual([]);
    const sous = roles.find((r) => r.job_role_code === 'SOUS_CHEF')!;
    expect(sous).toMatchObject({ job_title: 'Sous Chef', usual_department: 'KITCHEN' });
    expect(sous.default_duties.map((a) => `${a.duty} ${a.group}@${a.scope}`)).toEqual([
      'LEADS_SHIFT SUPERVISOR@home_department',
      'USES_DEPARTMENT_STORE STOCK_USER@department_store',
      'WORKS_SHIFTS STAFF@home_department',
    ]);
    const bar = roles.filter((r) => r.job_role_code === 'BAR_MANAGER');
    expect(
      bar.map(
        (r) =>
          `${r.outlet_format} ${r.usual_department} ${r.default_duties.map((a) => a.duty).join(',')}`,
      ),
    ).toEqual([
      'any BAR RUNS_DEPARTMENT,KEEPS_DEPARTMENT_STORE',
      'standalone_bar (outlet) RUNS_OUTLET,RUNS_OUTLET',
    ]);
  });

  it('uses a filled-in row as written, and adds no format the file lists itself', () => {
    const { roles } = read(
      'BAR_MANAGER,Bar Boss,any,BAR,RUNS_DEPARTMENT\nBAR_MANAGER,,standalone_bar,,',
    );
    expect(
      roles.map(
        (r) => `${r.outlet_format} ${r.job_title} ${r.default_duties.map((a) => a.duty).join(',')}`,
      ),
    ).toEqual([
      'any Bar Boss RUNS_DEPARTMENT',
      'standalone_bar Bar Manager RUNS_OUTLET,RUNS_OUTLET',
    ]);
  });

  it('a role not in the catalogue must be filled in', () => {
    const { issues } = read('TEA_MAKER,,any,KITCHEN,WORKS_SHIFTS');
    expect(issues).toEqual([
      {
        file: '06_job_roles.csv',
        row: 2,
        column: 'job_title',
        message: 'is required: TEA_MAKER is not a role in the catalogue',
      },
    ]);
  });

  it('the test customers differ from the catalogue only where listed', () => {
    const diffs: string[] = [];
    for (const customer of ['test-company', 'test-solo-bar-co']) {
      const t = parseCsv(readFileSync(join(DATA, customer, '06_job_roles.csv'), 'utf8'));
      for (const { values: v } of t.rows) {
        const role = ROLE_BY_CODE.get(v['job_role_code']!);
        if (!role) {
          diffs.push(`${customer} ${v['job_role_code']}: not in the catalogue`);
          continue;
        }
        const fmt = v['outlet_format'] as 'standalone_bar';
        const duties =
          (fmt in (role.formatDuties ?? {}) && role.formatDuties?.[fmt]) || role.duties;
        const home = role.formatHome?.[fmt] ?? role.home;
        const got = v['default_duties']!.split(';')
          .map((s) => s.trim())
          .filter(Boolean);
        if ([...got].sort().join() !== [...duties].sort().join()) {
          diffs.push(`${customer} ${role.code}: duties ${got.join('; ')}`);
        }
        if (v['job_title'] !== role.title)
          diffs.push(`${customer} ${role.code}: title ${v['job_title']}`);
        if (v['usual_department'] !== home) {
          diffs.push(`${customer} ${role.code}: department ${v['usual_department']}`);
        }
      }
    }
    expect(diffs).toEqual([
      // a Host works in both the hotel's restaurant and Bar 3.0's floor service
      'test-company HOST: department RESTAURANT / FLOOR-SERVICE',
      // the solo bar's Head Bartender keeps the bar store: there is no Bar Manager to
      'test-solo-bar-co HEAD_BARTENDER: duties LEADS_SHIFT; KEEPS_DEPARTMENT_STORE; WORKS_SHIFTS',
    ]);
  });

  it('the reference files list the catalogue', () => {
    const ref = catalogueReference();
    expect(
      readFileSync(join(DATA, 'PRODUCT_roles_REFERENCE.csv'), 'utf8'),
      'pnpm --filter @outlet-ops/onboarding catalogue-reference',
    ).toBe(ref.roles);
    expect(readFileSync(join(DATA, 'PRODUCT_departments_REFERENCE.csv'), 'utf8')).toBe(
      ref.departments,
    );
  });
});

// File 37 (ADR 061): what the file itself can get wrong, before the database checks a cover.
describe('who covers it (file 37)', () => {
  const company = readCustomerDir(
    join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding', 'test-data', 'test-company'),
  );
  const issuesWith = (rows: string[]) => {
    const files = {
      ...company,
      '37_role_cover.csv': ['outlet_code,job_role_code,mode,covered_by_role', ...rows].join('\n'),
    };
    const { bundle, issues } = readBundle(files);
    return issues.length ? issues : validateBundle(bundle);
  };
  const said = (rows: string[]) =>
    issuesWith(rows)
      .filter((i) => i.file === '37_role_cover.csv')
      .map((i) => `${i.row} ${i.column}: ${i.message}`);

  it('is optional, and a good file has nothing to say', () => {
    expect(said([])).toEqual([]);
    expect(
      said([
        'TEST-GUEST-HOUSE-2.0,STORE_KEEPER,covered_by,FRONT_DESK_EXECUTIVE',
        'TEST-BAR-3.0,COOK,not_done,',
      ]),
    ).toEqual([]);
  });

  it('names each mistake by row and column', () => {
    expect(
      said([
        'TEST-BAR-3.0-BAR,STORE_KEEPER,covered_by,BARTENDER',
        'TEST-BAR-3.0,NO_SUCH_ROLE,not_done,',
        'TEST-BAR-3.0,STORE_KEEPER,covered_by,',
        'TEST-BAR-3.0,CASHIER,not_done,HOST',
        'TEST-BAR-3.0,HOST,covered_by,HOST',
        'TEST-NOWHERE,HOST,not_done,',
      ]),
    ).toEqual([
      '2 outlet_code: TEST-BAR-3.0-BAR is a department: cover is set per outlet',
      '3 job_role_code: NO_SUCH_ROLE is not in 06_job_roles.csv',
      '4 covered_by_role: is required for covered_by',
      '5 covered_by_role: must be blank when the role is not done',
      '6 covered_by_role: a role cannot cover itself',
      '7 outlet_code: TEST-NOWHERE is not in 01_org_nodes.csv',
    ]);
  });

  it('refuses a role listed twice for an outlet, and chains', () => {
    expect(
      said([
        'TEST-BAR-3.0,STORE_KEEPER,covered_by,HEAD_BARTENDER',
        'TEST-BAR-3.0,STORE_KEEPER,not_done,',
        'TEST-BAR-3.0,HEAD_BARTENDER,covered_by,BARTENDER',
      ]),
    ).toEqual([
      '3 job_role_code: is listed twice for TEST-BAR-3.0',
      '2 covered_by_role: HEAD_BARTENDER is itself covered or not done at TEST-BAR-3.0: no chains',
    ]);
  });

  it('a bad mode is a parse error', () => {
    expect(
      issuesWith(['TEST-BAR-3.0,HOST,sometimes,']).map((i) => `${i.column}: ${i.message}`),
    ).toEqual(['mode: must be covered_by or not_done']);
  });
});
