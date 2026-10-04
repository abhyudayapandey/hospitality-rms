import { describe, expect, it } from 'vitest';
import { breakdownsFor, periodEnd, selectedPeriod, share } from './breakdowns';

describe('what is behind a figure (ADR 042)', () => {
  it('each figure opens the lists that make it up, where the report has them', () => {
    expect(breakdownsFor('outlet_flash', 'wastage')).toEqual(['wastage']);
    expect(breakdownsFor('outlet_flash', 'stock_value')).toEqual(['stock']);
    expect(breakdownsFor('outlet_flash', 'labour_pct')).toEqual(['cost', 'people']);
    expect(breakdownsFor('outlet_flash', 'flagged')).toEqual(['readings', 'tasks']);
    expect(breakdownsFor('outlet_flash', 'task_pct')).toEqual(['tasks']);
    expect(breakdownsFor('outlet_flash', 'sales')).toEqual(['dishes']);
    // Department has no dishes or cost breakdown
    expect(breakdownsFor('department', 'labour_cost')).toEqual(['people']);
    expect(breakdownsFor('cost_of_sales', 'food_cost_pct')).toEqual(['dishes', 'wastage']);
    expect(breakdownsFor('people', 'late')).toEqual(['people']);
    // no list: a figure with none, or a report the lists do not open from
    expect(breakdownsFor('outlet_flash', 'headcount')).toEqual([]);
    expect(breakdownsFor('central_kitchen', 'batches')).toEqual([]);
    expect(breakdownsFor('purchasing', 'orders')).toEqual([]);
  });

  it('periodEnd: a week is 7 days from Monday; a month to its last day', () => {
    expect(periodEnd('week', '2026-09-28')).toBe('2026-10-04');
    expect(periodEnd('month', '2026-09-01')).toBe('2026-09-30');
    expect(periodEnd('month', '2026-02-01')).toBe('2026-02-28');
  });

  it('selectedPeriod: the one asked for, else the latest with a figure; cut at today', () => {
    const points = [
      { period: '2026-09-14', value: '10' },
      { period: '2026-09-21', value: '12' },
      { period: '2026-09-28', value: null },
    ];
    expect(selectedPeriod(points, '2026-09-14', 'week', '2026-10-02')).toEqual({
      from: '2026-09-14',
      to: '2026-09-20',
    });
    expect(selectedPeriod(points, '', 'week', '2026-10-02')).toEqual({
      from: '2026-09-21',
      to: '2026-09-27',
    });
    // a period not on the chart is ignored
    expect(selectedPeriod(points, '2025-01-06', 'week', '2026-10-02')?.from).toBe('2026-09-21');
    expect(selectedPeriod(points, '2026-09-28', 'week', '2026-10-02')).toEqual({
      from: '2026-09-28',
      to: '2026-10-02',
    });
    expect(
      selectedPeriod([{ period: '2026-10-01', value: null }], '', 'month', '2026-10-04'),
    ).toEqual({ from: '2026-10-01', to: '2026-10-04' });
    expect(selectedPeriod([], '', 'week', '2026-10-02')).toBeNull();
  });

  it('share: one decimal of the whole; none without a whole', () => {
    expect(share(25, 200)).toBe('12.5');
    expect(share(1, 0)).toBeNull();
  });
});
