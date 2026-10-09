import { describe, expect, it } from 'vitest';
import { shiftTypeHours, shiftTypeTimes } from './shift-types';

const t = (x: Partial<Parameters<typeof shiftTypeTimes>[0]>) => ({
  name: 'X',
  shift_type: 'straight' as const,
  start: '07:00',
  end: '15:00',
  first_end: null,
  second_start: null,
  break_minutes: 0,
  ...x,
});

describe('shift types on their tiles (ADR 082)', () => {
  it('a straight shift, a split one and a panzer read as their times', () => {
    expect(shiftTypeTimes(t({}))).toBe('07:00–15:00');
    expect(
      shiftTypeTimes(
        t({
          shift_type: 'split',
          start: '11:00',
          end: '23:00',
          first_end: '15:00',
          second_start: '18:00',
        }),
      ),
    ).toBe('11:00–15:00 · 18:00–23:00');
    expect(shiftTypeTimes(t({ shift_type: 'panzer', start: '19:00', end: '04:00' }))).toBe(
      '19:00–04:00',
    );
  });

  it('their paid hours leave the breaks out and cross midnight', () => {
    expect(shiftTypeHours(t({}))).toBe(8);
    expect(
      shiftTypeHours(
        t({
          shift_type: 'split',
          start: '11:00',
          end: '23:00',
          first_end: '15:00',
          second_start: '18:00',
        }),
      ),
    ).toBe(9);
    expect(
      shiftTypeHours(t({ shift_type: 'panzer', start: '19:00', end: '04:00', break_minutes: 30 })),
    ).toBe(8.5);
  });
});
