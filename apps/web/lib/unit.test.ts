import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDevAuthEnabled } from './dev-auth';
import { ACCESS_GROUPS, DOMAINS } from '@outlet-ops/domain';
import { approvalsInNav, MAX_NAV_ITEMS, visibleNav, type NavFeatures } from './nav';
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
      reports: 'mine',
      ...f,
    }).map((i) => i.label);

  it('follows the UX-6 mock-ups (ADR 034)', () => {
    // frontline: three tabs; their tiles on Home do the rest
    expect(nav(['STAFF', 'PRODUCTION_TEAM'], ['PRODUCTION_TEAM'], { production: true })).toEqual([
      'Home',
      'Tasks',
      'Me',
    ]);
    expect(nav(['STAFF'], [])).toEqual(['Home', 'Tasks', 'Me']);
    expect(nav(['STAFF', 'STORE_KEEPER'], ['STOCK_LEVELS'])).toEqual([
      'Home',
      'Stock',
      'Tasks',
      'Me',
    ]);
    // department heads: approvals on Home; Roster, their stock (or tasks), reports
    expect(
      nav(['DEPARTMENT_HEAD', 'STORE_KEEPER'], ['STOCK_LEVELS'], {
        menu: true,
        reports: 'business',
      }),
    ).toEqual(['Home', 'Roster', 'Stock', 'Reports', 'Me']);
    expect(nav(['DEPARTMENT_HEAD'], [], { reports: 'business' })).toEqual([
      'Home',
      'Roster',
      'Tasks',
      'Reports',
      'Me',
    ]);
    expect(
      nav(['OUTLET_MANAGER', 'USER_ADMIN'], ['STOCK_LEVELS', 'USER_ACCESS'], {
        reports: 'business',
      }),
    ).toEqual(['Home', 'Approvals', 'Reports', 'Me']);
    expect(
      nav(['STAFF', 'COST_CONTROLLER'], ['STOCK_LEVELS', 'MENU'], {
        menu: true,
        reports: 'business',
      }),
    ).toEqual(['Home', 'Stock', 'Reports', 'Approvals', 'Me']);
    expect(nav(['HR_ADMIN'], [], { reports: 'business' })).toEqual([
      'Home',
      'Approvals',
      'Reports',
      'Roster',
      'Me',
    ]);
    expect(nav(['ACCOUNT_OWNER'], ['USER_ACCESS'], { reports: 'business' })).toEqual([
      'Home',
      'Approvals',
      'Reports',
      'Admin',
      'Me',
    ]);
  });

  it('only business reports take a tab; My week is on Me', () => {
    expect(nav(['AUDITOR'], ['AUDIT', 'SECURITY_ROLES'])).toEqual([
      'Home',
      'Approvals',
      'Admin',
      'Me',
    ]);
    expect(nav(['STAFF'], [], { reports: 'business' })).toEqual(['Home', 'Tasks', 'Me']);
  });

  it('a manager without reports gets Stock in that slot', () => {
    expect(nav(['OUTLET_MANAGER'], ['STOCK_LEVELS'])).toEqual(['Home', 'Approvals', 'Stock', 'Me']);
  });

  it('Approvals is a tab for managers and in the header for everyone else', () => {
    const input = (groups: string[]) => ({
      groups: new Set(['SELF', ...groups]),
      domains: new Set(SELF),
      menu: false,
      production: false,
      reports: 'business' as const,
    });
    expect(approvalsInNav(input(['OUTLET_MANAGER']))).toBe(true);
    expect(approvalsInNav(input(['STAFF']))).toBe(false);
    expect(approvalsInNav(input(['DEPARTMENT_HEAD']))).toBe(false);
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
