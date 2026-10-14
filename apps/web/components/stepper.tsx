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
 * The step of a reading's taps (ADR 098): a round 1, 2 or 5 (times a power of ten) that crosses
 * the safe range in at most 5 steps, so pH 7.2 to 7.8 goes by 0.2 and a chiller 0 to 5 by 1.
 * `fine` is the − / + step: never coarser than 1, and 0.1 under 1 so a decimal reading fits.
 * Null when the range is unknown.
 */
export function readingSteps(
  min: number | null,
  max: number | null,
): { pick: number; fine: number } | null {
  if (min === null || max === null || !(max > min)) return null;
  const width = max - min;
  let pick = 0;
  for (let p = -2; p <= 6 && !pick; p++) {
    for (const m of [1, 2, 5]) {
      const s = Number((m * 10 ** p).toPrecision(6));
      if (width / s <= 5 + 1e-9) {
        pick = s;
        break;
      }
    }
  }
  if (!pick) return null;
  const fine = pick >= 1 ? 1 : pick >= 0.1 ? 0.1 : pick;
  return { pick, fine };
}

const decimals = (s: number) => (String(s).split('.')[1] ?? '').length;

/**
 * Tap-a-number for a reading with a safe range (ADR 098): the safe range in round steps
 * (`readingSteps`), with one step either side; green inside the range, amber outside. The label
 * keeps the step's decimals ("7.0", "7.2"). None when the range is unknown.
 */
export function quickPicks(
  min: number | null,
  max: number | null,
): { value: number; label: string; tone: 'good' | 'near' | 'bad' }[] {
  const steps = readingSteps(min, max);
  if (!steps || min === null || max === null) return [];
  const s = steps.pick;
  const d = decimals(s);
  const lo = Math.ceil(min / s - 1e-9) - 1;
  const hi = Math.floor(max / s + 1e-9) + 1;
  const out: { value: number; label: string; tone: 'good' | 'near' | 'bad' }[] = [];
  for (let k = lo; k <= hi; k++) {
    const v = Number((k * s).toFixed(6));
    const gap = v < min ? min - v : v > max ? v - max : 0;
    out.push({
      value: v,
      label: v.toFixed(d),
      tone: gap < 1e-9 ? 'good' : gap <= s + 1e-9 ? 'near' : 'bad',
    });
  }
  return out;
}
