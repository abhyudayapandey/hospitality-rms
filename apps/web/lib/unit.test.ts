import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDevAuthEnabled } from './dev-auth';
import { visibleNav } from './nav';
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
  it('shows domain items only for domains the user has', () => {
    expect(visibleNav(new Set(['STOCK_LEVELS'])).map((i) => i.label)).toEqual([
      'Home',
      'Inbox',
      'Requests',
      'Stock',
    ]);
    expect(visibleNav(new Set(['ROSTER', 'SECURITY_ROLES'])).map((i) => i.label)).toEqual([
      'Home',
      'Inbox',
      'Requests',
      'Roster',
      'Admin',
    ]);
  });

  it('shows Admin to user administrators too', () => {
    expect(visibleNav(new Set(['USER_ACCESS'])).map((i) => i.label)).toContain('Admin');
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
