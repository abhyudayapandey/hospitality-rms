import Link from 'next/link';
import {
  TREND_CHARTS,
  TREND_GRAINS,
  TREND_MONTHS,
  type TrendChartKind,
  type TrendGrain,
} from '@/lib/reports';
import { chartRange, linePath, slotX, valueY } from '@/lib/trend-math';

// A trend as a line (a cost going up and down) or as bars (the parts of a total), one point
// a week or a month. Inline SVG: no chart library (ADR 041). The figures are listed under
// it too, so nothing is only a picture.

export type SeriesTone = 'brand' | 'light' | 'warn' | 'bad';

export interface TrendSeries {
  label: string;
  tone: SeriesTone;
  values: (number | null)[];
}

const FILL: Readonly<Record<SeriesTone, string>> = {
  brand: 'fill-brand-600',
  light: 'fill-brand-200',
  warn: 'fill-amber-400',
  bad: 'fill-rose-500',
};
const STROKE: Readonly<Record<SeriesTone, string>> = {
  brand: 'stroke-brand-600',
  light: 'stroke-slate-400',
  warn: 'stroke-amber-500',
  bad: 'stroke-rose-500',
};

const W = 320;
const H = 140;

export function TrendChart({
  kind,
  title,
  labels,
  series,
  stacked = false,
  format,
}: {
  kind: TrendChartKind;
  title: string;
  labels: string[];
  series: TrendSeries[];
  /** bars only: the series are parts of one total, stacked */
  stacked?: boolean;
  /** how the top of the scale reads (₹, %, hours) */
  format: (v: number) => string;
}) {
  const n = labels.length;
  const values = series.map((s) => s.values);
  const { min, max } = chartRange(values, kind === 'bar' && stacked);
  const slot = W / Math.max(1, n);
  const zero = valueY(0, min, max, H);
  return (
    <figure
      className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      data-testid="trend-chart"
      data-kind={kind}
    >
      <p className="text-xs text-slate-500 tabular-nums">{format(max)}</p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={title}
        className="h-40 w-full overflow-visible"
      >
        <line
          x1="0"
          x2={W}
          y1={H / 2}
          y2={H / 2}
          className="stroke-slate-100"
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1="0"
          x2={W}
          y1={zero}
          y2={zero}
          className="stroke-slate-300"
          vectorEffect="non-scaling-stroke"
        />
        {kind === 'bar'
          ? labels.map((_, i) => {
              if (stacked) {
                let top = zero;
                return series.map((s, j) => {
                  const v = Math.max(0, s.values[i] ?? 0);
                  const h = zero - valueY(v, min, max, H);
                  top -= h;
                  return (
                    <rect
                      key={`${i}-${j}`}
                      x={i * slot + slot * 0.15}
                      y={top}
                      width={slot * 0.7}
                      height={h}
                      className={FILL[s.tone]}
                    />
                  );
                });
              }
              const bw = (slot * 0.7) / Math.max(1, series.length);
              return series.map((s, j) => {
                const v = s.values[i];
                if (v === null || v === undefined) return null;
                const y = valueY(v, min, max, H);
                return (
                  <rect
                    key={`${i}-${j}`}
                    x={i * slot + slot * 0.15 + j * bw}
                    y={Math.min(y, zero)}
                    width={bw}
                    height={Math.abs(zero - y)}
                    className={FILL[s.tone]}
                  />
                );
              });
            })
          : series.map((s) => (
              <g key={s.label} className={STROKE[s.tone]}>
                <path
                  d={linePath(s.values, W, H, min, max)}
                  fill="none"
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
                {s.values.map((v, i) =>
                  v === null ? null : (
                    // a zero-length stroke with round caps: a dot that stays round when the
                    // chart stretches to the screen's width
                    <path
                      key={i}
                      d={`M${slotX(i, n, W)} ${valueY(v, min, max, H)} h0`}
                      strokeWidth={6}
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  ),
                )}
              </g>
            ))}
      </svg>
      <figcaption className="space-y-1 text-xs text-slate-500">
        <span className="flex justify-between tabular-nums">
          <span>{labels[0]}</span>
          <span>{min < 0 ? format(min) : ''}</span>
          <span>{labels.at(-1)}</span>
        </span>
        <span className="flex flex-wrap gap-3">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1">
              <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden>
                <rect width="10" height="10" className={FILL[s.tone]} />
              </svg>
              {s.label}
            </span>
          ))}
        </span>
      </figcaption>
    </figure>
  );
}

export interface TrendView {
  months: number;
  by: TrendGrain;
  chart: TrendChartKind;
}

/** 3, 6, 9 or 12 months; by week or month; a line or bars. Each a link keeping the others. */
export function TrendControls({
  view,
  href,
}: {
  view: TrendView;
  href: (change: Partial<TrendView>) => string;
}) {
  return (
    <div className="space-y-1.5" data-testid="trend-controls">
      <Segments
        label="Period"
        options={TREND_MONTHS.map((m) => ({
          key: String(m),
          text: `${m} months`,
          href: href({ months: m }),
          on: m === view.months,
        }))}
      />
      <div className="grid grid-cols-2 gap-1.5">
        <Segments
          label="By"
          options={TREND_GRAINS.map((g) => ({
            key: g,
            text: g === 'week' ? 'Weeks' : 'Months',
            href: href({ by: g }),
            on: g === view.by,
          }))}
        />
        <Segments
          label="Chart"
          options={TREND_CHARTS.map((c) => ({
            key: c,
            text: c === 'line' ? 'Line' : 'Bars',
            href: href({ chart: c }),
            on: c === view.chart,
          }))}
        />
      </div>
    </div>
  );
}

function Segments({
  label,
  options,
}: {
  label: string;
  options: { key: string; text: string; href: string; on: boolean }[];
}) {
  return (
    <nav
      aria-label={label}
      className="grid gap-1 rounded-lg bg-slate-100 p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <Link
          key={o.key}
          href={o.href}
          replace
          scroll={false}
          aria-current={o.on ? 'page' : undefined}
          className={`flex min-h-11 items-center justify-center rounded-md text-sm ${
            o.on ? 'bg-white font-semibold shadow-sm' : 'text-slate-600'
          }`}
        >
          {o.text}
        </Link>
      ))}
    </nav>
  );
}

/** A trend page's link with some of its settings changed. */
export function trendLink(base: string, view: TrendView, change: Partial<TrendView>): string {
  const v = { ...view, ...change };
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}months=${v.months}&by=${v.by}&chart=${v.chart}`;
}

export function TrendFigure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
