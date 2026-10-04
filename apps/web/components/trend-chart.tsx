import Link from 'next/link';
import { TREND_GRAINS } from '@/lib/reports';

// A trend as bars, one per day, week or month, each split into its parts (a dish's sales
// into recipe cost and margin; a stock item's use into used and wasted). Inline SVG: no
// chart library (ADR 041). The figures are listed under it too, so nothing is only a picture.

export type BarTone = 'brand' | 'light' | 'warn' | 'bad';

export interface TrendBar {
  label: string;
  parts: { value: number; tone: BarTone }[];
}

const FILL: Readonly<Record<BarTone, string>> = {
  brand: 'fill-brand-600',
  light: 'fill-brand-200',
  warn: 'fill-amber-400',
  bad: 'fill-rose-500',
};

export function TrendChart({
  bars,
  title,
  legend,
}: {
  bars: TrendBar[];
  title: string;
  legend: { label: string; tone: BarTone }[];
}) {
  const total = (b: TrendBar) => b.parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  const max = Math.max(1, ...bars.map(total));
  const w = 100 / Math.max(1, bars.length);
  return (
    <figure
      className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      data-testid="trend-chart"
    >
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        role="img"
        aria-label={title}
        className="h-36 w-full"
      >
        {bars.map((b, i) => {
          let y = 40;
          return b.parts.map((p, j) => {
            const h = (Math.max(0, p.value) / max) * 38;
            y -= h;
            return (
              <rect
                key={`${i}-${j}`}
                x={i * w + w * 0.15}
                y={y}
                width={w * 0.7}
                height={h}
                className={FILL[p.tone]}
              />
            );
          });
        })}
      </svg>
      <figcaption className="flex justify-between text-xs text-slate-500">
        <span>{bars[0]?.label}</span>
        <span className="flex gap-3">
          {legend.map((l) => (
            <span key={l.label} className="flex items-center gap-1">
              <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden>
                <rect width="10" height="10" className={FILL[l.tone]} />
              </svg>
              {l.label}
            </span>
          ))}
        </span>
        <span>{bars.at(-1)?.label}</span>
      </figcaption>
    </figure>
  );
}

/** Day, week or month, as links. */
export function TrendGrains({ link, by }: { link: (g: string) => string; by: string }) {
  return (
    <nav aria-label="By" className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
      {TREND_GRAINS.map((g) => (
        <Link
          key={g}
          href={link(g)}
          aria-current={g === by ? 'page' : undefined}
          className={`flex min-h-11 items-center justify-center rounded-md text-sm ${
            g === by ? 'bg-white font-semibold shadow-sm' : 'text-slate-600'
          }`}
        >
          {g === 'day' ? '14 days' : g === 'week' ? '13 weeks' : '12 months'}
        </Link>
      ))}
    </nav>
  );
}

export function TrendFigure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
