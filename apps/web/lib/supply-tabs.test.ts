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

describe('Stock tabs: 4, then More / Less in the same row (ADR 054)', () => {
  it('shows the first 4 and keeps the rest, in order, closed', () => {
    const { shown, more, open } = splitTabs(tabs, '/stock');
    expect(shown.map((t) => t.href)).toEqual([
      '/stock',
      '/stock/orders',
      '/stock/transfers',
      '/stock/count',
    ]);
    expect(more.map((t) => t.href)).toEqual([
      '/stock/wastage',
      '/stock/production',
      '/stock/check',
      '/stock/bills',
    ]);
    expect(open).toBe(false);
  });
  it('on one of the rest, the row opens with the order kept', () => {
    const { shown, more, open } = splitTabs(tabs, '/stock/bills');
    expect(open).toBe(true);
    expect(shown.map((t) => t.href)).not.toContain('/stock/bills');
    expect(more.at(-1)?.href).toBe('/stock/bills');
  });
  it('no More for one extra tab: it would hide only one', () => {
    expect(splitTabs(tabs.slice(0, 5), '/stock')).toMatchObject({ more: [], open: false });
  });
});
