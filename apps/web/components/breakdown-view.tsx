import type {
  DishLine,
  PersonLine,
  ReadingLine,
  StockLine,
  TaskLine,
  WastageLine,
} from '@/lib/report-data';
import { share } from '@/lib/breakdowns';
import { formatMeasure } from '@/lib/reports';
import { formatDay, formatTime } from '@/lib/dates';

// What is behind a figure (ADR 042): each list in its own section, collapsed until tapped,
// its headline (how many, what total) on the closed section, biggest first inside.

const money = (v: string | number | null) => formatMeasure('money', v);
const pct = (v: string | number | null) => formatMeasure('pct', v);
const hrs = (v: string | number | null) => formatMeasure('hours', v);
const qtyText = (q: string, unit: string) =>
  `${Number(q).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${unit}`;
const sum = <T,>(rows: readonly T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);

/** A section that opens and closes; closed by default. */
export function Accordion({
  title,
  summary,
  testId,
  open = false,
  children,
}: {
  title: string;
  summary?: string;
  testId: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      className="group rounded-xl bg-white ring-1 ring-slate-200"
      data-testid={testId}
      open={open}
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-sm font-semibold">{title}</span>
          {summary && <span className="block text-xs text-slate-500">{summary}</span>}
        </span>
        <span
          aria-hidden
          className="shrink-0 text-slate-400 transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <div className="border-t border-slate-100">{children}</div>
    </details>
  );
}

function Row({
  name,
  sub,
  value,
  note,
}: {
  name: string;
  sub?: string | undefined;
  value: string;
  note?: string | undefined;
}) {
  return (
    <li className="flex items-baseline justify-between gap-3 px-4 py-2 text-sm">
      <span className="min-w-0">
        <span className="block font-medium">{name}</span>
        {sub && <span className="block text-xs text-slate-500">{sub}</span>}
      </span>
      <span className="shrink-0 text-right tabular-nums">
        <span className="block">{value}</span>
        {note && <span className="block text-xs text-slate-500">{note}</span>}
      </span>
    </li>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-3 text-sm text-slate-500">{children}</p>;
}

const list = 'divide-y divide-slate-100';

export function dishesSummary(rows: readonly DishLine[]) {
  const sales = sum(rows, (r) => Number(r.sales));
  const cost = sum(rows, (r) => Number(r.cost));
  return `${rows.length} dishes · ${money(sales)} sales · cost ${pct(share(cost, sales))}`;
}

export function Dishes({ rows }: { rows: readonly DishLine[] }) {
  if (rows.length === 0) return <Empty>No sales in this period.</Empty>;
  const total = sum(rows, (r) => Number(r.sales));
  return (
    <ul className={list} data-testid="bd-dishes">
      {rows.map((r) => (
        <Row
          key={`${r.menu}|${r.dish}`}
          name={r.dish}
          sub={`${r.menu} · ${Number(r.qty)} sold · ${pct(share(Number(r.sales), total))} of sales`}
          value={money(r.sales)}
          note={`cost ${money(r.cost)} · ${pct(share(Number(r.cost), Number(r.sales)))}`}
        />
      ))}
    </ul>
  );
}

export function wastageSummary(rows: readonly WastageLine[]) {
  const items = new Set(rows.map((r) => r.item)).size;
  return `${items} ${items === 1 ? 'item' : 'items'} · ${money(sum(rows, (r) => Number(r.value)))}`;
}

const REASON: Readonly<Record<string, string>> = {
  expired: 'Expired',
  transit_loss: 'Lost in transit',
  damaged: 'Damaged',
  spoiled: 'Spoiled',
  prep_error: 'Prep error',
  other: 'Other',
};

export function Wastage({ rows }: { rows: readonly WastageLine[] }) {
  if (rows.length === 0) return <Empty>Nothing thrown away in this period.</Empty>;
  const total = sum(rows, (r) => Number(r.value));
  return (
    <ul className={list} data-testid="bd-wastage">
      {rows.map((r) => (
        <Row
          key={`${r.item}|${r.store}|${r.reason}`}
          name={r.item}
          sub={`${qtyText(r.qty, r.unit)} · ${REASON[r.reason] ?? r.reason} · ${r.store} · by ${r.recorded_by}`}
          value={money(r.value)}
          note={`${pct(share(Number(r.value), total))} of wastage`}
        />
      ))}
    </ul>
  );
}

export function stockSummary(rows: readonly StockLine[]) {
  return `${rows.length} items · ${money(sum(rows, (r) => Number(r.value)))}`;
}

export function Stock({ rows }: { rows: readonly StockLine[] }) {
  if (rows.length === 0) return <Empty>No stock held.</Empty>;
  const total = sum(rows, (r) => Number(r.value));
  return (
    <ul className={list} data-testid="bd-stock">
      {rows.map((r) => (
        <Row
          key={`${r.item}|${r.store}`}
          name={r.item}
          sub={`${qtyText(r.qty, r.unit)} · ${r.category ? `${r.category} · ` : ''}${r.store}`}
          value={money(r.value)}
          note={`${pct(share(Number(r.value), total))} of stock`}
        />
      ))}
    </ul>
  );
}

export function peopleSummary(rows: readonly PersonLine[]) {
  const late = sum(rows, (r) => r.late);
  const missed = sum(rows, (r) => r.no_shows);
  return `${rows.length} people · ${hrs(sum(rows, (r) => Number(r.worked_hours)))} worked · ${late} late · ${missed} no-shows`;
}

export function People({ rows }: { rows: readonly PersonLine[] }) {
  if (rows.length === 0) return <Empty>No shifts in this period.</Empty>;
  return (
    <ul className={list} data-testid="bd-people">
      {rows.map((r) => (
        <Row
          key={`${r.person}|${r.job ?? ''}`}
          name={r.person}
          sub={`${r.job ? `${r.job} · ` : ''}${r.shifts} ${r.shifts === 1 ? 'shift' : 'shifts'} · rostered ${hrs(r.rostered_hours)}`}
          value={`${hrs(r.worked_hours)} worked`}
          note={
            r.late + r.no_shows > 0
              ? [r.late > 0 && `${r.late} late`, r.no_shows > 0 && `${r.no_shows} no-show`]
                  .filter(Boolean)
                  .join(' · ')
              : 'on time'
          }
        />
      ))}
    </ul>
  );
}

export function tasksSummary(rows: readonly TaskLine[]) {
  const due = sum(rows, (r) => r.due);
  const onTime = sum(rows, (r) => r.on_time);
  return `${due} due · ${pct(share(onTime, due))} on time · ${sum(rows, (r) => r.overdue)} overdue`;
}

export function Tasks({ rows }: { rows: readonly TaskLine[] }) {
  if (rows.length === 0) return <Empty>No tasks due in this period.</Empty>;
  return (
    <ul className={list} data-testid="bd-tasks">
      {rows.map((r) => (
        <Row
          key={r.person}
          name={r.person}
          sub={`${r.due} due · ${r.done} done · ${r.overdue} overdue${r.flagged > 0 ? ` · ${r.flagged} flagged` : ''}`}
          value={`${pct(share(r.on_time, r.due))} on time`}
        />
      ))}
    </ul>
  );
}

export function readingsSummary(rows: readonly ReadingLine[]) {
  return `${rows.length} flagged ${rows.length === 1 ? 'reading' : 'readings'}`;
}

export function Readings({ rows }: { rows: readonly ReadingLine[] }) {
  if (rows.length === 0) return <Empty>No readings out of range in this period.</Empty>;
  return (
    <ul className={list} data-testid="bd-readings">
      {rows.map((r, i) => (
        <Row
          key={i}
          name={`${r.reading}: ${r.value}`}
          sub={`${r.task} · by ${r.by_name}${r.done_at ? ` · ${formatDay(r.done_at.slice(0, 10))} ${formatTime(new Date(r.done_at))}` : ''}`}
          value={r.allowed ? `allowed ${r.allowed}` : 'flagged'}
        />
      ))}
    </ul>
  );
}
