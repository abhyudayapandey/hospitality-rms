import { describe, expect, it } from 'vitest';
import {
  compare,
  DISH_CLASSES,
  dishClass,
  formatMeasure,
  MEASURES,
  periodRange,
  PERIODS,
  REPORTS,
  sectionRows,
  SECTIONS,
  topLosses,
} from './reports';

describe('formatMeasure', () => {
  it('reads like the phone shows it', () => {
    expect(formatMeasure('money', '24195.00')).toBe('₹24,195');
    expect(formatMeasure('money', 548311.37)).toBe('₹5,48,311');
    expect(formatMeasure('pct', '21.5')).toBe('21.5%');
    expect(formatMeasure('hours', '159.00')).toBe('159 h');
    expect(formatMeasure('hours', '4.50')).toBe('4.5 h');
    expect(formatMeasure('count', '3')).toBe('3');
    expect(formatMeasure('pct', null)).toBe('–');
    expect(formatMeasure('money', 'x')).toBe('–');
    expect(formatMeasure('days', '41.9')).toBe('41.9 days');
    expect(formatMeasure('days', 1)).toBe('1 day');
  });
});

describe('compare', () => {
  it('says which way and whether that is good', () => {
    expect(compare(MEASURES.sales!, '1200', '1000')).toEqual({
      text: '▲ ₹200 vs last week',
      trend: 'good',
    });
    expect(compare(MEASURES.food_cost_pct!, '31.5', '29')).toEqual({
      text: '▲ 2.5 pts vs last week',
      trend: 'bad',
    });
    expect(compare(MEASURES.late!, '1', '3')).toEqual({ text: '▼ 2 vs last week', trend: 'good' });
    expect(compare(MEASURES.stock_value!, '10', '20').trend).toBe('none');
    expect(compare(MEASURES.sales!, '5', '5')).toEqual({
      text: 'same as last week',
      trend: 'same',
    });
    expect(compare(MEASURES.task_pct!, null, '50')).toEqual({ text: '', trend: 'none' });
  });
});

describe('sections', () => {
  it('every measure in a section has a label', () => {
    for (const sections of Object.values(SECTIONS)) {
      for (const [, measures] of sections) {
        for (const m of measures) expect(MEASURES[m], m).toBeDefined();
      }
    }
  });

  it('keeps the section order and skips what the data does not have', () => {
    const rows = sectionRows(
      [
        { measure: 'stock_value', value: '1' },
        { measure: 'wastage', value: '2' },
      ],
      ['wastage', 'wastage_pct', 'stock_value'],
    );
    expect(rows.map((r) => [r.measure, r.def.label])).toEqual([
      ['wastage', 'Wastage'],
      ['stock_value', 'Stock value'],
    ]);
  });
});

describe('the cost controller reports (ADR 028)', () => {
  it('every report has a page, and the four new ones come after the R-1 reports', () => {
    expect(Object.keys(REPORTS)).toEqual([
      'outlet_flash',
      'department',
      'cost_of_sales',
      'menu_engineering',
      'stock_position',
      'purchasing',
      'my_week',
    ]);
    expect(REPORTS.cost_of_sales.href).toBe('/reports/cost');
  });

  it('periodRange: the days each period covers, never past today', () => {
    const today = '2026-10-02';
    expect(periodRange('yesterday', today)).toEqual({
      period: 'yesterday',
      from: '2026-10-01',
      to: '2026-10-01',
    });
    expect(periodRange(undefined, today)).toEqual({
      period: 'week',
      from: '2026-09-26',
      to: '2026-10-02',
    });
    expect(periodRange('four_weeks', today).from).toBe('2026-09-05');
    expect(periodRange('month', today)).toEqual({
      period: 'month',
      from: '2026-10-01',
      to: '2026-10-02',
    });
    // custom: put in order, kept to today
    expect(periodRange('custom', today, '2026-10-30', '2026-09-20')).toEqual({
      period: 'custom',
      from: '2026-09-20',
      to: '2026-10-02',
    });
    // custom without both dates, or with nonsense: the default week
    expect(periodRange('custom', today, '2026-09-20').period).toBe('week');
    expect(periodRange('custom', today, 'x', 'y').period).toBe('week');
    expect(PERIODS.map((p) => p.code)).toContain('custom');
  });

  it('topLosses: only losses, the biggest first, five at most', () => {
    const items = [
      { sku: 'A', variance_value: '-140' },
      { sku: 'B', variance_value: '0' },
      { sku: 'C', variance_value: '-1800' },
      { sku: 'D', variance_value: '25' },
      ...[1, 2, 3, 4].map((i) => ({ sku: `E${i}`, variance_value: `-${i}` })),
    ];
    expect(topLosses(items).map((i) => i.sku)).toEqual(['C', 'A', 'E4', 'E3', 'E2']);
    expect(topLosses(items, 1).map((i) => i.sku)).toEqual(['C']);
    expect(topLosses([{ variance_value: '10' }])).toEqual([]);
  });

  it('dish classes: four groups with a hint each; anything else is unplaced', () => {
    expect(DISH_CLASSES.map((c) => c.code)).toEqual(['star', 'plowhorse', 'puzzle', 'dog']);
    for (const c of DISH_CLASSES) expect(c.hint.length).toBeGreaterThan(10);
    expect(dishClass('puzzle')).toBe('puzzle');
    expect(dishClass(null)).toBeNull();
    expect(dishClass('cat')).toBeNull();
  });
});
