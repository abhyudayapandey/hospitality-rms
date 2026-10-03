// Reports (ADR 023): names, the measures each report shows, and how a figure reads. Pure:
// the figures come from rpt.* functions, which decide who may see what (rule 2).

export type ReportCode =
  | 'outlet_flash'
  | 'department'
  | 'cost_of_sales'
  | 'menu_engineering'
  | 'stock_position'
  | 'purchasing'
  | 'my_week';

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
    // the cost controller's reports (R-2, ADR 028)
    cost_of_sales: {
      title: 'Cost of sales',
      href: '/reports/cost',
      blurb: 'Food and drink cost against the recipes, and the items losing the most.',
    },
    menu_engineering: {
      title: 'Menu engineering',
      href: '/reports/menu',
      blurb: 'Each dish by margin and popularity: stars, plowhorses, puzzles and dogs.',
    },
    stock_position: {
      title: 'Stock position',
      href: '/reports/stock',
      blurb: 'Stock value, days on hand and stock that has not moved.',
    },
    purchasing: {
      title: 'Purchasing',
      href: '/reports/purchasing',
      blurb: 'Price changes and how fully and on time suppliers deliver.',
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

export type Unit = 'money' | 'pct' | 'hours' | 'count' | 'days';

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
  // cost of sales
  food_recipe_pct: { label: 'Food cost by recipe', unit: 'pct' },
  bar_recipe_pct: { label: 'Drinks cost by recipe', unit: 'pct' },
  count_loss: { label: 'Lost at the count', unit: 'money', better: 'down' },
  beyond_tolerance: { label: 'Items beyond tolerance', unit: 'count', better: 'down' },
  not_counted: { label: 'Items not counted', unit: 'count' },
  expired: { label: 'Expired, thrown away', unit: 'money', better: 'down' },
  // stock position
  value_7: { label: 'A week ago', unit: 'money' },
  value_14: { label: '2 weeks ago', unit: 'money' },
  value_21: { label: '3 weeks ago', unit: 'money' },
  value_28: { label: '4 weeks ago', unit: 'money' },
  used_value: { label: 'Used in the last 28 days', unit: 'money' },
  basis_days: { label: 'Days of use averaged', unit: 'days' },
  days_on_hand: { label: 'Days on hand', unit: 'days' },
  dead_items: { label: 'Items not moved in 30 days', unit: 'count', better: 'down' },
  dead_value: { label: 'Their value', unit: 'money', better: 'down' },
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
  cost_of_sales: [
    ['Sales', ['food_sales', 'bar_sales']],
    [
      'Cost against the recipes',
      ['food_cost_pct', 'food_recipe_pct', 'bar_cost_pct', 'bar_recipe_pct'],
    ],
    ['Losses', ['count_loss', 'beyond_tolerance', 'not_counted', 'wastage', 'expired']],
  ],
  stock_position: [
    ['Value', ['stock_value', 'value_7', 'value_14', 'value_21', 'value_28']],
    ['Use', ['used_value', 'days_on_hand', 'basis_days']],
    ['Dead stock', ['dead_items', 'dead_value']],
  ],
  // lists, not measures
  menu_engineering: [],
  purchasing: [],
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
    case 'days':
      return `${hours.format(v)} ${v === 1 ? 'day' : 'days'}`;
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

// ---------------------------------------------------------------------------------------
// The cost controller's reports (R-2, ADR 028)
// ---------------------------------------------------------------------------------------

export type Period = 'yesterday' | 'week' | 'four_weeks' | 'month' | 'custom';

export const PERIODS: readonly { code: Period; label: string }[] = [
  { code: 'yesterday', label: 'Yesterday' },
  { code: 'week', label: 'Last 7 days' },
  { code: 'four_weeks', label: 'Last 4 weeks' },
  { code: 'month', label: 'This month' },
  { code: 'custom', label: 'Pick dates' },
];

const isIso = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

function shift(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The days a period covers, ending today at the latest. "Last 7 days" ends today, as the
 * Variance screen did; custom dates are put in order and kept to today.
 */
export function periodRange(
  period: string | undefined,
  today: string,
  from?: string,
  to?: string,
): { period: Period; from: string; to: string } {
  if (period === 'yesterday') {
    const y = shift(today, -1);
    return { period, from: y, to: y };
  }
  if (period === 'four_weeks') return { period, from: shift(today, -27), to: today };
  if (period === 'month') return { period, from: `${today.slice(0, 8)}01`, to: today };
  if (period === 'custom' && isIso(from) && isIso(to)) {
    const [a, b] = from <= to ? [from, to] : [to, from];
    const end = b > today ? today : b;
    return { period, from: a > end ? end : a, to: end };
  }
  return { period: 'week', from: shift(today, -6), to: today };
}

export interface CostItem {
  store_name: string;
  sku: string;
  name: string;
  unit: string;
  variance_qty: string;
  variance_value: string;
  counted: boolean;
  unexplained: boolean;
}

/** "Where the money went": the items that lost the most at the count, biggest first. */
export function topLosses<T extends Pick<CostItem, 'variance_value'>>(
  items: readonly T[],
  n = 5,
): T[] {
  return items
    .filter((i) => Number(i.variance_value) < 0)
    .sort((a, b) => Number(a.variance_value) - Number(b.variance_value))
    .slice(0, n);
}

export type DishClass = 'star' | 'plowhorse' | 'puzzle' | 'dog';

/** The four groups of the menu engineering matrix, in the order the screen shows them. */
export const DISH_CLASSES: readonly {
  code: DishClass;
  title: string;
  what: string;
  hint: string;
}[] = [
  {
    code: 'star',
    title: 'Stars',
    what: 'Popular, high margin',
    hint: 'Keep them as they are and make them easy to find.',
  },
  {
    code: 'plowhorse',
    title: 'Plowhorses',
    what: 'Popular, low margin',
    hint: 'Raise the price a little or cut the recipe cost.',
  },
  {
    code: 'puzzle',
    title: 'Puzzles',
    what: 'High margin, not popular',
    hint: 'Promote them: a better place on the menu, a staff suggestion.',
  },
  {
    code: 'dog',
    title: 'Dogs',
    what: 'Low margin, not popular',
    hint: 'Rework them or take them off the menu.',
  },
];

/** A dish class from the database, or null when there is none (nothing sold, no recipe). */
export function dishClass(s: string | null): DishClass | null {
  return s === 'star' || s === 'plowhorse' || s === 'puzzle' || s === 'dog' ? s : null;
}
