import { MODULE_CODES } from '@outlet-ops/domain';
import { describe, expect, it } from 'vitest';
import { canOpen, visibleNav, type NavInput } from './nav';
import { MODULE_DOMAINS, modulesOn, withModules } from './modules';
import { peopleTabs } from './roster-view';

const rows = (off: string[]) => MODULE_CODES.map((code) => ({ code, on: !off.includes(code) }));

describe('modulesOn', () => {
  it('everything on when nothing is off', () => {
    expect([...modulesOn(rows([]))].sort()).toEqual([...MODULE_CODES].sort());
  });
  it('prep lists go off with production', () => {
    const on = modulesOn(rows(['production']));
    expect(on.has('production')).toBe(false);
    expect(on.has('prep_lists')).toBe(false);
    expect(on.has('checklists')).toBe(true);
  });
  it('every module is in the domain map', () => {
    expect(Object.keys(MODULE_DOMAINS).sort()).toEqual([...MODULE_CODES].sort());
  });
});

describe('withModules', () => {
  const domains = new Map<string, 'view' | 'modify'>([
    ['ROSTER', 'modify'],
    ['EVENTS', 'view'],
    ['SHIFT_SWAPS', 'modify'],
    ['LEAVE', 'view'],
    ['PRODUCTION_TEAM', 'modify'],
    ['MENU', 'view'],
    ['SALES', 'modify'],
    ['STOCK_LEVELS', 'view'],
  ]);
  it('drops the domains of switched-off modules only', () => {
    const d = withModules(domains, modulesOn(rows(['events', 'swaps', 'menu_sales'])));
    expect([...d.keys()].sort()).toEqual(['LEAVE', 'PRODUCTION_TEAM', 'ROSTER', 'STOCK_LEVELS']);
    expect(d.get('ROSTER')).toBe('modify');
  });
  it('keeps everything when all are on', () => {
    expect(withModules(domains, modulesOn(rows([])))).toEqual(domains);
  });
});

describe('what disappears from the screens', () => {
  it('a server at a company without Events and Swaps: no Swaps tab, no Events', () => {
    const d = withModules(
      new Map([
        ['ROSTER', 'view'],
        ['EVENTS', 'view'],
        ['LEAVE', 'view'],
        ['SHIFT_SWAPS', 'modify'],
        ['ATTENDANCE', 'modify'],
      ]),
      modulesOn(rows(['events', 'swaps'])),
    );
    const t = peopleTabs({
      can: (x, a = 'view') => d.has(x) && (a === 'view' || d.get(x) === 'modify'),
      personal: true,
      exceptions: false,
    });
    expect(t.me.map((x) => x.label)).toEqual(['My shifts', 'Clock', 'Leave']);
  });
  it('a cook without Production loses the Production nav item', () => {
    const input: NavInput = {
      groups: new Set(['SELF', 'STAFF', 'PRODUCTION_TEAM']),
      domains: new Set(['ROSTER', 'TASKS']),
      menu: false,
      production: false,
      reports: 'mine',
    };
    expect(canOpen('production', input)).toBe(false);
    expect(visibleNav(input).map((n) => n.label)).toEqual(['Home', 'Tasks', 'Roster', 'Inbox']);
  });
});
