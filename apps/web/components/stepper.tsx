'use client';

/**
 * A number with − and + either side (ADR 098): people who type slowly tap instead, and can
 * still type an exact figure. Steps by `step` (1 by default), never below `min` when given;
 * an empty box steps from `start` (the min, else 0).
 */
export function Stepper({
  value,
  onChange,
  label,
  step = 1,
  min,
  start,
  unit,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  /** what the number is, for screen readers and tests */
  label: string;
  step?: number;
  min?: number | undefined;
  start?: number | undefined;
  unit?: string | null | undefined;
  testId?: string;
}) {
  const bump = (d: number) => {
    const from = value.trim() === '' ? (start ?? min ?? 0) - (d > 0 ? step : -step) : Number(value);
    if (!Number.isFinite(from)) return;
    let next = Math.round((from + d * step) * 1000) / 1000;
    if (min !== undefined && next < min) next = min;
    onChange(String(next));
  };
  const button =
    'flex size-14 shrink-0 items-center justify-center rounded-xl bg-white text-2xl font-semibold ring-1 ring-slate-300 active:bg-slate-100';
  return (
    <div className="flex items-center gap-2" data-testid={testId}>
      <button type="button" className={button} aria-label="Less" onClick={() => bump(-1)}>
        −
      </button>
      <span className="relative min-w-0 flex-1">
        <input
          inputMode="decimal"
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-14 w-full rounded-xl border border-slate-300 bg-white px-3 text-center text-2xl font-semibold tabular-nums"
        />
        {unit && (
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-slate-500">
            {unit}
          </span>
        )}
      </span>
      <button type="button" className={button} aria-label="More" onClick={() => bump(1)}>
        +
      </button>
    </div>
  );
}

/**
 * Tap-a-number for a reading with a safe range (ADR 098): the whole numbers around it, green
 * inside the range, amber just outside, red beyond. None when the range is wide or unknown.
 */
export function quickPicks(
  min: number | null,
  max: number | null,
): { value: number; tone: 'good' | 'near' | 'bad' }[] {
  if (min === null || max === null || max - min > 8) return [];
  const lo = Math.floor(min) - 1;
  const hi = Math.ceil(max) + 2;
  const out: { value: number; tone: 'good' | 'near' | 'bad' }[] = [];
  for (let v = lo; v <= hi; v++) {
    const gap = v < min ? min - v : v > max ? v - max : 0;
    out.push({ value: v, tone: gap === 0 ? 'good' : gap <= 1 ? 'near' : 'bad' });
  }
  return out;
}
