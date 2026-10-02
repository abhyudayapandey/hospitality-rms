import { describe, expect, it } from 'vitest';
import { FILES } from './files';

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
