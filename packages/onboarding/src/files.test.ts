import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUTIES } from '@outlet-ops/domain';
import { describe, expect, it } from 'vitest';
import { FILES, jobRoleAccess } from './files';

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
