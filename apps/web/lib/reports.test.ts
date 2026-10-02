import { describe, expect, it } from 'vitest';
import { compare, formatMeasure, MEASURES, sectionRows, SECTIONS } from './reports';

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
