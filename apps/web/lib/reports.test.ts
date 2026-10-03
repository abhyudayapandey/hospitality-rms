import { describe, expect, it } from 'vitest';
import {
  capRange,
  compare,
  costParts,
  DISH_CLASSES,
  dishClass,
  flashCostParts,
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
      'central_kitchen',
      'people',
      'my_week',
    ]);
    expect(REPORTS.cost_of_sales.href).toBe('/reports/cost');
    expect(REPORTS.people.href).toBe('/reports/people');
    expect(REPORTS.central_kitchen.href).toBe('/reports/kitchen');
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

describe('where the money went (R-3, ADR 030)', () => {
  it('costParts: in order, labelled, only the parts the data has', () => {
    const list = costParts([
      { part: 'prime', value: '900', pct: '60.0' },
      { part: 'food_recipe', value: '300', pct: '20.0' },
      { part: 'materials', value: '400', pct: '26.7' },
      { part: 'unknown', value: '1', pct: null },
    ]);
    expect(list.map((p) => p.part)).toEqual(['food_recipe', 'materials', 'prime']);
    expect(list.map((p) => !!p.total)).toEqual([false, true, true]);
  });

  it('flashCostParts: Outlet today measures as parts, each a share of the sales', () => {
    const parts = flashCostParts([
      { measure: 'sales', value: '2000' },
      { measure: 'cost_food_recipe', value: '500' },
      { measure: 'cost_materials', value: '640' },
      { measure: 'labour_cost', value: '700' },
      { measure: 'prime_cost', value: '1340' },
      { measure: 'late', value: '2' },
    ]);
    expect(parts).toEqual([
      { part: 'food_recipe', value: '500', pct: '25.0' },
      { part: 'materials', value: '640', pct: '32.0' },
      { part: 'labour', value: '700', pct: '35.0' },
      { part: 'prime', value: '1340', pct: '67.0' },
    ]);
    // no sales: no share
    expect(flashCostParts([{ measure: 'cost_materials', value: '10' }])).toEqual([
      { part: 'materials', value: '10', pct: null },
    ]);
  });

  it('capRange: at most 93 days, ending where asked', () => {
    expect(capRange('2026-01-01', '2026-10-02')).toEqual({ from: '2026-07-02', to: '2026-10-02' });
    expect(capRange('2026-09-26', '2026-10-02')).toEqual({ from: '2026-09-26', to: '2026-10-02' });
  });
});
