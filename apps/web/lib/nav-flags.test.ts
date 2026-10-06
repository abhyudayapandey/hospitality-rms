import { describe, expect, it } from 'vitest';
import { navFlagsKey } from './nav-flags';

const domains = new Map([
  ['STOCK_LEVELS', 'view'],
  ['MENU', 'view'],
]);
const modules = new Set(['inventory', 'menu_sales']);
const roles = new Set(['STORE_KEEPER']);
const base = navFlagsKey('u1', domains, modules, roles, 'home1');

describe('the bottom nav checks are asked again when access changes (ADR 055)', () => {
  it('does not depend on the order things come in', () => {
    const reordered = navFlagsKey(
      'u1',
      new Map([
        ['MENU', 'view'],
        ['STOCK_LEVELS', 'view'],
      ]),
      new Set(['menu_sales', 'inventory']),
      roles,
      'home1',
    );
    expect(reordered).toBe(base);
  });
  it('changes with the person, a domain, its access, a module, a role or the home place', () => {
    const variants = [
      navFlagsKey('u2', domains, modules, roles, 'home1'),
      navFlagsKey('u1', new Map([['STOCK_LEVELS', 'view']]), modules, roles, 'home1'),
      navFlagsKey(
        'u1',
        new Map([
          ['STOCK_LEVELS', 'modify'],
          ['MENU', 'view'],
        ]),
        modules,
        roles,
        'home1',
      ),
      navFlagsKey('u1', domains, new Set(['inventory']), roles, 'home1'),
      navFlagsKey('u1', domains, modules, new Set(['STORE_KEEPER', 'SUPERVISOR']), 'home1'),
      navFlagsKey('u1', domains, modules, roles, 'home2'),
      navFlagsKey('u1', domains, modules, roles, null),
    ];
    for (const v of variants) expect(v).not.toBe(base);
    expect(new Set(variants).size).toBe(variants.length);
  });
});
