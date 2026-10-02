// Reports (ADR 023): names, the measures each report shows, and how a figure reads. Pure:
// the figures come from rpt.* functions, which decide who may see what (rule 2).

export type ReportCode = 'outlet_flash' | 'department' | 'my_week';

export const REPORTS: Readonly<Record<ReportCode, { title: string; href: string; blurb: string }>> =
  {
    outlet_flash: {
      title: 'Outlet today',
      href: '/reports/outlet',
      blurb: 'Sales, food and drink cost, wastage, hours and tasks, against last week.',
    },
    department: {
      title: 'Department today',
      href: '/reports/department',
      blurb: 'Who is on shift, hours, open slots and tasks done on time.',
    },
    my_week: {
      title: 'My week',
      href: '/reports/my-week',
      blurb: 'Your shifts, hours worked, on-time record and tasks.',
    },
  };

export function isReportCode(s: string): s is ReportCode {
  return s in REPORTS;
}

export type Unit = 'money' | 'pct' | 'hours' | 'count';

export interface MeasureDef {
  label: string;
  unit: Unit;
  /** which way is good: shown green or red against last week; none = neutral */
  better?: 'up' | 'down';
}

export const MEASURES: Readonly<Record<string, MeasureDef>> = {
  sales: { label: 'Sales', unit: 'money', better: 'up' },
  food_sales: { label: 'Food sales', unit: 'money', better: 'up' },
  bar_sales: { label: 'Drinks sales', unit: 'money', better: 'up' },
  food_cost_pct: { label: 'Food cost', unit: 'pct', better: 'down' },
  bar_cost_pct: { label: 'Drinks cost', unit: 'pct', better: 'down' },
  wastage: { label: 'Wastage', unit: 'money', better: 'down' },
  wastage_pct: { label: 'Wastage of sales', unit: 'pct', better: 'down' },
  stock_value: { label: 'Stock value', unit: 'money' },
  scheduled_hours: { label: 'Hours rostered', unit: 'hours' },
  worked_hours: { label: 'Hours worked', unit: 'hours' },
  shifts: { label: 'Shifts', unit: 'count' },
  open_slots: { label: 'Open slots', unit: 'count', better: 'down' },
  late: { label: 'Late', unit: 'count', better: 'down' },
  no_shows: { label: 'No-shows', unit: 'count', better: 'down' },
  on_time: { label: 'Shifts on time', unit: 'count', better: 'up' },
  tasks_due: { label: 'Tasks due', unit: 'count' },
  tasks_done: { label: 'Tasks done', unit: 'count', better: 'up' },
  tasks_on_time: { label: 'Done on time', unit: 'count', better: 'up' },
  task_pct: { label: 'Tasks on time', unit: 'pct', better: 'up' },
  flagged: { label: 'Readings flagged', unit: 'count', better: 'down' },
  overdue: { label: 'Overdue', unit: 'count', better: 'down' },
};

/** The sections of each report, in order (a measure missing from the data is skipped). */
export const SECTIONS: Readonly<Record<ReportCode, readonly [string, readonly string[]][]>> = {
  outlet_flash: [
    ['Sales', ['sales', 'food_sales', 'bar_sales']],
    ['Cost (recipe)', ['food_cost_pct', 'bar_cost_pct']],
    ['Stock', ['wastage', 'wastage_pct', 'stock_value']],
    ['People', ['scheduled_hours', 'worked_hours', 'open_slots', 'late', 'no_shows']],
    ['Tasks', ['task_pct', 'tasks_due', 'overdue', 'flagged']],
  ],
  department: [
    ['People', ['shifts', 'scheduled_hours', 'worked_hours', 'open_slots', 'late', 'no_shows']],
    ['Tasks', ['task_pct', 'tasks_due', 'tasks_done', 'overdue', 'flagged']],
    ['Store', ['wastage', 'stock_value']],
  ],
  my_week: [
    ['Shifts', ['shifts', 'scheduled_hours', 'worked_hours', 'on_time', 'late', 'no_shows']],
    ['Tasks', ['tasks_done', 'tasks_on_time']],
  ],
};

const group = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const hours = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });

/** A figure as it reads on the phone: '₹24,195', '21.5%', '159 h', '3'; '–' when there is none. */
export function formatMeasure(unit: Unit, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '–';
  const v = Number(value);
  if (!Number.isFinite(v)) return '–';
  switch (unit) {
    case 'money':
      return `₹${group.format(v)}`;
    case 'pct':
      return `${v.toFixed(1)}%`;
    case 'hours':
      return `${hours.format(v)} h`;
    case 'count':
      return group.format(v);
  }
}

export type Trend = 'good' | 'bad' | 'same' | 'none';

/** Against last week: the change as words, and whether it is good news. */
export function compare(
  def: MeasureDef,
  now: string | number | null | undefined,
  then: string | number | null | undefined,
): { text: string; trend: Trend } {
  if (now === null || now === undefined || then === null || then === undefined) {
    return { text: '', trend: 'none' };
  }
  const a = Number(now);
  const b = Number(then);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { text: '', trend: 'none' };
  if (a === b) return { text: 'same as last week', trend: 'same' };
  const up = a > b;
  const trend: Trend = !def.better ? 'none' : (def.better === 'up') === up ? 'good' : 'bad';
  // percentages move in points; everything else by its own amount
  const diff = Math.abs(a - b);
  const amount =
    def.unit === 'pct'
      ? `${diff.toFixed(1)} pts`
      : def.unit === 'money'
        ? `₹${group.format(diff)}`
        : def.unit === 'hours'
          ? `${hours.format(diff)} h`
          : group.format(diff);
  return { text: `${up ? '▲' : '▼'} ${amount} vs last week`, trend };
}

export interface MeasureRow {
  measure: string;
  value: string | null;
  last_week?: string | null;
}

/** The rows of one section that the data has, with their labels. */
export function sectionRows(rows: readonly MeasureRow[], measures: readonly string[]) {
  const by = new Map(rows.map((r) => [r.measure, r]));
  return measures.flatMap((m) => {
    const r = by.get(m);
    const def = MEASURES[m];
    return r && def ? [{ ...r, def }] : [];
  });
}
