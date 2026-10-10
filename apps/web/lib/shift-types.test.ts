import { describe, expect, it } from 'vitest';
import { shiftIcon, shiftTypeHours, shiftTypeTimes } from './shift-types';

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

describe('a picture per shift (ADR 108)', () => {
  const tz = 'Asia/Kolkata';
  it('morning and day: the sun; evening, night and panzer: the moon; split: two blocks', () => {
    expect(shiftIcon('straight', '2026-10-10T01:30:00Z', tz)).toBe('sun'); // 07:00
    expect(shiftIcon('straight', '2026-10-10T08:30:00Z', tz)).toBe('sun'); // 14:00
    expect(shiftIcon('straight', '2026-10-10T09:30:00Z', tz)).toBe('moon'); // 15:00
    expect(shiftIcon('straight', '2026-10-09T20:30:00Z', tz)).toBe('moon'); // 02:00
    expect(shiftIcon('panzer', '2026-10-10T01:30:00Z', tz)).toBe('moon');
    expect(shiftIcon('split', '2026-10-10T05:30:00Z', tz)).toBe('split');
    expect(shiftIcon(null, new Date('2026-10-10T03:30:00Z'), tz)).toBe('sun');
    // a shift type's own times
    expect(shiftIcon('straight', '07:00', tz)).toBe('sun');
    expect(shiftIcon('straight', '16:00:00', tz)).toBe('moon');
  });
});
