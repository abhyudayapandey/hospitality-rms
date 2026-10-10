// How a shift type reads on its tile (ADR 082): "Morning 07:00–15:00", "Split 11:00–15:00 ·
// 18:00–23:00", "Panzer 19:00–04:00". Free of server-only code so the tiles and tests share it.

export interface ShiftTypeWords {
  name: string;
  shift_type: 'straight' | 'split' | 'panzer';
  start: string;
  end: string;
  first_end: string | null;
  second_start: string | null;
  break_minutes: number;
}

export function shiftTypeTimes(t: ShiftTypeWords): string {
  if (t.shift_type === 'split' && t.first_end && t.second_start) {
    return `${t.start}–${t.first_end} · ${t.second_start}–${t.end}`;
  }
  return `${t.start}–${t.end}`;
}

/** The hours it pays, without the breaks: a split 11–15 and 18–23 is 9 hours. */
export function shiftTypeHours(t: ShiftTypeWords): number {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  let span = m(t.end) - m(t.start);
  if (span <= 0) span += 24 * 60;
  const gap =
    t.shift_type === 'split' && t.first_end && t.second_start
      ? m(t.second_start) - m(t.first_end)
      : 0;
  return (span - gap - t.break_minutes) / 60;
}

/**
 * A shift's picture on the roster, My shifts and the clock (ADR 108): a split shift its two
 * blocks, a panzer the moon; a straight shift the sun when it starts between 05:00 and 14:59
 * where it is worked, else the moon (an evening or a night).
 */
export function shiftIcon(
  shiftType: string | null | undefined,
  /** when it starts: an instant, or a shift type's local "HH:MM" */
  startAt: Date | string,
  tz: string,
): 'sun' | 'moon' | 'split' {
  if (shiftType === 'split') return 'split';
  if (shiftType === 'panzer') return 'moon';
  // a shift type's own start, "19:00", is already where it is worked
  const hour = /^\d\d:\d\d(:\d\d)?$/.test(String(startAt))
    ? Number(String(startAt).slice(0, 2))
    : Number(
        new Intl.DateTimeFormat('en-GB', {
          hour: '2-digit',
          hourCycle: 'h23',
          timeZone: tz,
        }).format(new Date(startAt)),
      );
  return hour >= 5 && hour < 15 ? 'sun' : 'moon';
}
