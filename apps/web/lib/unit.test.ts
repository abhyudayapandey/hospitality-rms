import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDevAuthEnabled } from './dev-auth';
import { ACCESS_GROUPS, DOMAINS } from '@outlet-ops/domain';
import { MAX_NAV_ITEMS, moreItems, visibleNav, type NavFeatures } from './nav';
import { isScreen, withChoice } from './place-screens';
import { startPoller } from './poller';

describe('dev auth gate', () => {
  it('is on only outside production with DEV_AUTH_STUB=true', () => {
    expect(isDevAuthEnabled({ NODE_ENV: 'development', DEV_AUTH_STUB: 'true' })).toBe(true);
    expect(isDevAuthEnabled({ NODE_ENV: 'test', DEV_AUTH_STUB: 'true' })).toBe(true);
    expect(isDevAuthEnabled({ NODE_ENV: 'production', DEV_AUTH_STUB: 'true' })).toBe(false);
    expect(isDevAuthEnabled({ NODE_ENV: 'development', DEV_AUTH_STUB: 'false' })).toBe(false);
    expect(isDevAuthEnabled({ NODE_ENV: 'development' })).toBe(false);
  });
});

describe('bottom nav', () => {
  // the domains each kind of person has (core.my_domains() includes SELF's)
  const SELF = ['ROSTER', 'TASKS', 'MAINTENANCE', 'LEAVE', 'ATTENDANCE'];
  const nav = (groups: string[], domains: string[], f: Partial<NavFeatures> = {}) =>
    visibleNav({
      groups: new Set(['SELF', ...groups]),
      domains: new Set([...SELF, ...domains]),
      menu: false,
      production: false,
      ...f,
    }).map((i) => i.label);

  it('follows the approved table (ADR 020)', () => {
    expect(nav(['STAFF', 'PRODUCTION_TEAM'], ['PRODUCTION_TEAM'], { production: true })).toEqual([
      'Home',
      'Tasks',
      'Production',
      'Roster',
      'Inbox',
    ]);
    expect(nav(['STAFF'], [])).toEqual(['Home', 'Tasks', 'Roster', 'Inbox']);
    expect(nav(['STAFF', 'STORE_KEEPER'], ['STOCK_LEVELS'])).toEqual([
      'Home',
      'Inbox',
      'Stock',
      'Tasks',
      'Roster',
    ]);
    expect(nav(['DEPARTMENT_HEAD', 'STORE_KEEPER'], ['STOCK_LEVELS'], { menu: true })).toEqual([
      'Home',
      'Inbox',
      'Tasks',
      'Roster',
      'Stock',
    ]);
    expect(nav(['DEPARTMENT_HEAD'], [])).toEqual(['Home', 'Inbox', 'Tasks', 'Roster', 'Requests']);
    expect(nav(['OUTLET_MANAGER', 'USER_ADMIN'], ['STOCK_LEVELS', 'USER_ACCESS'])).toEqual([
      'Home',
      'Inbox',
      'Stock',
      'Roster',
      'Tasks',
    ]);
    expect(nav(['STAFF', 'COST_CONTROLLER'], ['STOCK_LEVELS', 'MENU'], { menu: true })).toEqual([
      'Home',
      'Inbox',
      'Stock',
      'Menu',
      'Requests',
    ]);
    expect(nav(['HR_ADMIN'], [])).toEqual(['Home', 'Inbox', 'Roster', 'Requests']);
    expect(nav(['ACCOUNT_OWNER'], ['USER_ACCESS'])).toEqual(['Home', 'Inbox', 'Admin', 'Requests']);
  });

  it('frontline staff with stock access get Stock, which leads to Production', () => {
    expect(
      nav(['STAFF', 'PRODUCTION_TEAM', 'STOCK_USER'], ['STOCK_LEVELS'], { production: true }),
    ).toEqual(['Home', 'Tasks', 'Stock', 'Roster', 'Inbox']);
  });

  it('never shows more than five items, for any mix of groups', () => {
    const all = ACCESS_GROUPS.map((g) => g.code);
    const domains = DOMAINS.map((d) => d.code);
    for (const g of all) {
      for (const h of all) {
        expect(nav([g, h], domains, { menu: true, production: true }).length).toBeLessThanOrEqual(
          MAX_NAV_ITEMS,
        );
      }
    }
  });

  it('Home links to what the nav leaves out', () => {
    const input = {
      groups: new Set(['SELF', 'STAFF']),
      domains: new Set([...SELF, 'USER_ACCESS']),
      menu: true,
      production: false,
    };
    expect(moreItems(input).map((i) => i.label)).toEqual(['Menu', 'Requests']);
    expect(visibleNav(input).map((i) => i.label)).toContain('Admin');
  });
});

describe('place switcher memory', () => {
  it('replaces one screen’s choice and keeps the others', () => {
    expect(JSON.parse(withChoice({ stock: 'a', roster: 'b' }, 'stock', 'c'))).toEqual({
      stock: 'c',
      roster: 'b',
    });
    expect(isScreen('production')).toBe(true);
    expect(isScreen('inbox')).toBe(false);
  });
});

describe('poller', () => {
  afterEach(() => vi.useRealTimers());

  function fakeDoc(visible: boolean) {
    let cb: (() => void) | undefined;
    return {
      env: {
        isVisible: () => visible,
        onVisibilityChange: (fn: () => void) => {
          cb = fn;
          return () => (cb = undefined);
        },
      },
      set(v: boolean) {
        visible = v;
        cb?.();
      },
      subscribed: () => cb !== undefined,
    };
  }

  it('ticks every 30 s while visible, pauses while hidden, ticks on return', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const doc = fakeDoc(true);
    const stop = startPoller(tick, 30_000, doc.env);
    vi.advanceTimersByTime(90_000);
    expect(tick).toHaveBeenCalledTimes(3);

    doc.set(false);
    vi.advanceTimersByTime(120_000);
    expect(tick).toHaveBeenCalledTimes(3);

    doc.set(true); // immediate refresh on return
    expect(tick).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(30_000);
    expect(tick).toHaveBeenCalledTimes(5);

    stop();
    vi.advanceTimersByTime(300_000);
    expect(tick).toHaveBeenCalledTimes(5);
    expect(doc.subscribed()).toBe(false);
  });

  it('does not start while hidden', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    startPoller(tick, 30_000, fakeDoc(false).env);
    vi.advanceTimersByTime(120_000);
    expect(tick).not.toHaveBeenCalled();
  });
});
