import { describe, expect, it } from 'vitest';
import { splitTabs } from './supply-tabs';

const tabs = [
  '/stock',
  '/stock/orders',
  '/stock/transfers',
  '/stock/count',
  '/stock/wastage',
  '/stock/production',
  '/stock/check',
  '/stock/bills',
].map((href) => ({ href }));

describe('supply tabs: 4, the rest under More (ADR 053)', () => {
  it('shows the first 4 and keeps the rest', () => {
    const { shown, more } = splitTabs(tabs, '/stock');
    expect(shown.map((t) => t.href)).toEqual([
      '/stock',
      '/stock/orders',
      '/stock/transfers',
      '/stock/count',
    ]);
    expect(more).toHaveLength(4);
  });
  it('the screen you are on is always shown', () => {
    const { shown, more } = splitTabs(tabs, '/stock/bills');
    expect(shown.map((t) => t.href)).toContain('/stock/bills');
    expect(shown).toHaveLength(4);
    expect(more.map((t) => t.href)).not.toContain('/stock/bills');
    expect(more.map((t) => t.href)).toContain('/stock/count');
  });
  it('no More for one extra tab: it would hide only one', () => {
    expect(splitTabs(tabs.slice(0, 5), '/stock').more).toEqual([]);
  });
});
