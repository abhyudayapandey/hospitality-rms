import { describe, expect, it } from 'vitest';
import { CHECKLIST_BY_CODE, CHECKLISTS, levelOf, ROLE_BY_CODE, TILES } from '@outlet-ops/domain';
import { planOutlet, type OutletChoice } from './outlet-template';

// The plan an outlet's choices give (ADR 062), before it becomes files.

const choice = (tile: string, more: Partial<OutletChoice> = {}): OutletChoice => ({
  tile,
  extras: [],
  code: 'NEW-1',
  name: 'New',
  parentCode: 'AREA',
  timezone: 'Asia/Kolkata',
  ...more,
});

describe('the plan for an outlet', () => {
  it('a café: café pieces on; the restaurant ones offered after them, unticked', () => {
    const p = planOutlet(choice('cafe'));
    expect(p.departments.map((d) => d.code)).toEqual(['KITCHEN', 'COUNTER']);
    expect(p.offered).toEqual([
      { code: 'ADMIN-FINANCE', name: 'Admin & Finance' },
      { code: 'RESTAURANT', name: 'Restaurant', alsoIn: 'restaurant' },
      { code: 'STORES-TEAM', name: 'Stores', alsoIn: 'restaurant' },
    ]);
    expect(p.roles.map((r) => r.code)).toContain('BARISTA');
    expect(p.roles.map((r) => r.code)).not.toContain('CAPTAIN');
  });

  it('a café that ticks the dining room gets its people and checklists, not the restaurant kitchen’s', () => {
    const p = planOutlet(choice('cafe', { departments: ['KITCHEN', 'COUNTER', 'RESTAURANT'] }));
    const roles = p.roles.map((r) => r.code);
    expect(roles).toEqual(expect.arrayContaining(['CAPTAIN', 'STEWARD', 'HOST', 'BARISTA']));
    expect(roles).not.toContain('COMMIS');
    const lists = p.checklists.map((c) => c.code);
    expect(lists).toEqual(expect.arrayContaining(['RESTAURANT-OPENING', 'COUNTER-OPENING']));
    expect(lists).not.toContain('HOT-HOLDING');
  });

  it('restaurant + bar: the bar comes ticked, with its people, checklists and stock', () => {
    const p = planOutlet(choice('restaurant_bar', { extras: ['bar'] }));
    expect(p.departments.map((d) => d.code)).toContain('BAR');
    expect(p.roles.map((r) => r.code)).toEqual(
      expect.arrayContaining(['BAR_MANAGER', 'BARTENDER']),
    );
    expect(p.checklists.map((c) => c.code)).toContain('BAR-SETUP');
    expect(p.items.map((i) => i.code)).toContain('VODKA');
    expect(p.format).toBe('restaurant');
  });

  it('a role that runs another department comes only with that department', () => {
    expect(planOutlet(choice('hotel')).roles.map((r) => r.code)).not.toContain('FANDB_MANAGER');
    expect(
      planOutlet(choice('hotel', { extras: ['bar', 'banquets'] })).roles.map((r) => r.code),
    ).toContain('FANDB_MANAGER');
  });

  it('a hotel: breakfast is the restaurant’s, said beside it; no spa or pool unless ticked', () => {
    const p = planOutlet(choice('hotel'));
    expect(p.departments.find((d) => d.code === 'RESTAURANT')?.note).toBe(
      'includes breakfast; untick if no meals are served',
    );
    expect(p.departments.map((d) => d.code)).not.toContain('SPA-RECREATION');
    expect(p.roles.map((r) => r.code)).not.toContain('LIFEGUARD');
  });

  it('a hotel with a pool, a spa and a gym: Spa & Recreation, its people and SOP checks', () => {
    const p = planOutlet(choice('hotel', { extras: ['pool', 'spa', 'gym'] }));
    expect(p.departments.map((d) => d.code)).toContain('SPA-RECREATION');
    expect(p.roles.map((r) => r.code)).toEqual(
      expect.arrayContaining([
        'RECREATION_MANAGER',
        'LIFEGUARD',
        'SPA_MANAGER',
        'THERAPIST',
        'SPA_RECEPTIONIST',
      ]),
    );
    expect(p.checklists.map((c) => [c.code, c.department])).toEqual(
      expect.arrayContaining([
        ['POOL-SAFETY', 'SPA-RECREATION'],
        // the pool plant is Engineering's (EN-08)
        ['POOL-WATER-TEST', 'ENGINEERING'],
        ['SPA-OPENING', 'SPA-RECREATION'],
        ['GYM-CHECK', 'SPA-RECREATION'],
      ]),
    );
    // a gym alone needs no lifeguard or therapist
    const gym = planOutlet(choice('hotel', { extras: ['gym'] })).roles.map((r) => r.code);
    expect(gym).toContain('RECREATION_MANAGER');
    expect(gym).not.toContain('LIFEGUARD');
    expect(gym).not.toContain('THERAPIST');
  });

  it('amenities are a hotel’s only', () => {
    expect(() => planOutlet(choice('restaurant', { extras: ['pool'] }))).toThrow(
      /not offered for Restaurant only/,
    );
  });

  it('banquets switch the Events module on', () => {
    expect(planOutlet(choice('hotel')).modules).not.toContain('events');
    expect(planOutlet(choice('hotel', { extras: ['banquets'] })).modules).toContain('events');
  });
});

// Every role's daily work (ADR 075): each library checklist goes to the first of its SOP
// roles that works in its department at the outlet, and every role that works shifts in
// an operational department has a checklist of its own every day, whatever is ticked.
describe('who does each starter checklist', () => {
  const OFFICE = new Set(['ADMIN-FINANCE', 'HR', 'IT', 'SALES-MARKETING']);
  const plans = TILES.flatMap((t) => {
    const extras = t.offers.filter((x) => x !== 'central_kitchen');
    const base = planOutlet(choice(t.code, { extras: [...(t.with ?? [])] }));
    const every = [...base.departments, ...base.offered].map((d) => d.code);
    return [
      { name: `${t.code}`, plan: base },
      {
        name: `${t.code} with every extra and department`,
        plan: planOutlet(choice(t.code, { extras, departments: every })),
      },
    ];
  });

  it.each(plans)('$name: every role that works shifts has a daily checklist', ({ plan }) => {
    const missing = plan.roles
      .filter((r) => !r.department.startsWith('(') && !OFFICE.has(r.department))
      .filter((r) => levelOf(ROLE_BY_CODE.get(r.code)!.duties) === 'works')
      .filter(
        (r) =>
          !plan.checklists.some(
            (c) =>
              c.assignTo === `role:${r.code}` &&
              !CHECKLIST_BY_CODE.get(c.code)!.schedule.startsWith('weekly'),
          ),
      )
      .map((r) => r.code);
    expect(missing).toEqual([]);
  });

  it('a hotel: the server-steward sets the dining room, the room attendant cleans rooms', () => {
    const p = planOutlet(choice('hotel'));
    const to = (code: string) => p.checklists.find((c) => c.code === code)?.assignTo;
    expect(to('RESTAURANT-OPENING')).toBe('role:STEWARD');
    expect(to('PRE-SHIFT-BRIEFING')).toBe('role:CAPTAIN');
    expect(to('ROOM-CLEANING')).toBe('role:ROOM_ATTENDANT');
    expect(to('LOBBY-WASHROOM')).toBe('role:PUBLIC_AREA_ATTENDANT');
    expect(to('KITCHEN-OPENING')).toBe('role:COMMIS');
  });

  it('with none of its roles in that department, whoever is on shift does it', () => {
    // a café's receiving check is in its kitchen, where there is no store keeper
    const p = planOutlet(choice('cafe'));
    expect(p.checklists.find((c) => c.code === 'RECEIVING-CHECK')).toMatchObject({
      department: 'KITCHEN',
      assignTo: 'on_shift',
    });
    // and a café's kitchen opens with its cook (it has no commis)
    expect(p.checklists.find((c) => c.code === 'KITCHEN-OPENING')?.assignTo).toBe('role:COOK');
  });

  it('every library checklist names catalogue roles that do it', () => {
    for (const c of CHECKLISTS) {
      expect(c.roles.length, c.code).toBeGreaterThan(0);
      for (const r of c.roles) expect(ROLE_BY_CODE.has(r), `${c.code}: ${r}`).toBe(true);
    }
  });
});
