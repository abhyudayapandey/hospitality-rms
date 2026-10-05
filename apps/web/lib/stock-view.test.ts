import { describe, expect, it } from 'vitest';
import { stockHref, stockTab } from './stock-view';

describe('the one Stock screen (ADR 048)', () => {
  it('the tab: ?tab=, else the older low=1 or show=', () => {
    expect(stockTab({})).toBe('all');
    expect(stockTab({ tab: 'expired' })).toBe('expired');
    expect(stockTab({ low: '1' })).toBe('low');
    expect(stockTab({ below: '1' })).toBe('low');
    expect(stockTab({ show: 'expired' })).toBe('expired');
    expect(stockTab({ show: 'expiring' })).toBe('expiring');
    expect(stockTab({ tab: 'nonsense' })).toBe('all');
  });

  it('every way in builds the same URL', () => {
    expect(stockHref()).toBe('/stock');
    expect(stockHref({ tab: 'low', all: true })).toBe('/stock?all=1&tab=low');
    expect(stockHref({ tab: 'expired', all: true })).toBe('/stock?all=1&tab=expired');
    expect(stockHref({ tab: 'expiring', node: 'n1' })).toBe('/stock?node=n1&tab=expiring');
    expect(stockHref({ tab: 'all', node: 'n1' })).toBe('/stock?node=n1');
  });
});
