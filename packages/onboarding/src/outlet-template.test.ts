import { describe, expect, it } from 'vitest';
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
