import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, readSettings, TARGET_OF, TARGETS, vsTarget } from './settings';

const t = DEFAULT_SETTINGS.targets;

describe('vsTarget', () => {
  it('a cost is bad only when over its target by more than 2 points', () => {
    expect(vsTarget('food_cost_pct', '32', t)).toEqual({ target: 30, state: 'ok' });
    expect(vsTarget('food_cost_pct', '32.1', t)).toEqual({ target: 30, state: 'bad' });
    expect(vsTarget('food_cost_pct', '12', t)).toEqual({ target: 30, state: 'ok' });
    expect(vsTarget('labour_pct', 27.5, t)).toEqual({ target: 25, state: 'bad' });
  });

  it('tasks on time are bad only when under target by more than 2 points', () => {
    expect(vsTarget('task_pct', '88', t)).toEqual({ target: 90, state: 'ok' });
    expect(vsTarget('task_pct', '87.9', t)).toEqual({ target: 90, state: 'bad' });
    expect(vsTarget('tasks_pct', '100', t)).toEqual({ target: 90, state: 'ok' });
  });

  it('no target for other measures; no state without a figure', () => {
    expect(vsTarget('sales', '1000', t)).toEqual({ target: null, state: 'none' });
    expect(vsTarget('prime_pct', null, t)).toEqual({ target: 60, state: 'none' });
    expect(vsTarget('drink_pct', 'x', t)).toEqual({ target: 22, state: 'none' });
  });

  it('every target applies to some measure', () => {
    const used = new Set(Object.values(TARGET_OF));
    expect(TARGETS.every((x) => used.has(x.key))).toBe(true);
  });
});

describe('readSettings', () => {
  it('fills what is missing from the defaults', () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings({ targets: { food: 28 }, po_send_prices: true })).toEqual({
      ...DEFAULT_SETTINGS,
      targets: { ...DEFAULT_SETTINGS.targets, food: 28 },
      po_send_prices: true,
    });
  });
});
