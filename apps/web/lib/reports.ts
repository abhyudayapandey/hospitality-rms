// Reports (ADR 023): names, the measures each report shows, and how a figure reads. Pure:
// the figures come from rpt.* functions, which decide who may see what (rule 2).

import { weekStart } from './dates';

export type ReportCode =
  | 'league'
  | 'outlet_flash'
  | 'department'
  | 'cost_of_sales'
  | 'menu_engineering'
  | 'stock_position'
  | 'purchasing'
  | 'central_kitchen'
  | 'people'
  | 'my_week';

export const REPORTS: Readonly<Record<ReportCode, { title: string; href: string; blurb: string }>> =
  {
    // R-4 (ADR 031): the area manager's and owner's first report
    league: {
      title: 'Outlets side by side',
      href: '/reports/league',
      blurb: 'Every outlet’s sales, costs, wastage and tasks against the targets.',
    },
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
    // R-3 (ADR 030)
    central_kitchen: {
      title: 'Central kitchen',
      href: '/reports/kitchen',
      blurb: 'What was made, what went out to each outlet, and what was lost on the way.',
    },
    people: {
      title: 'People',
      href: '/reports/people',
      blurb: 'Headcount, hours and overtime, lateness and no-shows, and leave.',
    },
    my_week: {
      title: 'My week',
      href: '/reports/my-week',
      blurb: 'Your shifts, hours worked, on-time record and tasks.',
    },
  };

/** The list's groups, by the question each report answers (UX-7). */
export const REPORT_GROUPS: readonly { title: string; reports: readonly ReportCode[] }[] = [
  { title: 'How are we doing?', reports: ['league', 'outlet_flash', 'department', 'my_week'] },
  {
    title: 'What does it cost?',
    reports: ['cost_of_sales', 'purchasing', 'stock_position', 'central_kitchen'],
  },
  { title: 'What do we sell?', reports: ['menu_engineering'] },
  { title: 'Our people', reports: ['people'] },
];

/** The reports a person has, grouped; a group with none is left out, order within it kept. */
export function groupReports(codes: readonly ReportCode[]) {
  return REPORT_GROUPS.map((g) => ({
    title: g.title,
    reports: g.reports.filter((r) => codes.includes(r)),
  })).filter((g) => g.reports.length > 0);
}

export function isReportCode(s: string): s is ReportCode {
  return s in REPORTS;
}

export type Unit = 'money' | 'pct' | 'hours' | 'count' | 'days';

export interface MeasureDef {
  label: string;
  unit: Unit;
  /** which way is good: shown green or red against last week; none = neutral */
  better?: 'up' | 'down';
  /** one line under the label for a term a GM or owner may not know (UX-7); the label stays */
  hint?: string;
}

export const MEASURES: Readonly<Record<string, MeasureDef>> = {
  sales: { label: 'Sales', unit: 'money', better: 'up' },
  food_sales: { label: 'Food sales', unit: 'money', better: 'up' },
  bar_sales: { label: 'Drinks sales', unit: 'money', better: 'up' },
  food_cost_pct: {
    label: 'Food cost',
    unit: 'pct',
    better: 'down',
    hint: 'Cost of the food sold, as a share of food sales.',
  },
  bar_cost_pct: {
    label: 'Drinks cost',
    unit: 'pct',
    better: 'down',
    hint: 'Cost of the drinks sold, as a share of drinks sales.',
  },
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
  beyond_tolerance: {
    label: 'Items beyond tolerance',
    unit: 'count',
    better: 'down',
    hint: 'Counted stock that differs from the book by more than the allowed margin.',
  },
  not_counted: {
    label: 'Items not counted',
    unit: 'count',
    hint: 'Items nobody counted in this period, so any loss on them is not known.',
  },
  expired: { label: 'Expired, thrown away', unit: 'money', better: 'down' },
  // stock position
  value_7: { label: 'A week ago', unit: 'money' },
  value_14: { label: '2 weeks ago', unit: 'money' },
  value_21: { label: '3 weeks ago', unit: 'money' },
  value_28: { label: '4 weeks ago', unit: 'money' },
  used_value: { label: 'Used in the last 28 days', unit: 'money' },
  basis_days: { label: 'Days of use averaged', unit: 'days' },
  days_on_hand: {
    label: 'Days on hand',
    unit: 'days',
    hint: 'How many days the stock lasts at the recent rate of use.',
  },
  dead_items: {
    label: 'Items not moved in 30 days',
    unit: 'count',
    better: 'down',
    hint: 'Items with no movement (no use, sale or transfer) for 30 days.',
  },
  dead_value: {
    label: 'Their value',
    unit: 'money',
    better: 'down',
    hint: 'Money tied up in stock that is not moving.',
  },
  // RPT-14 (ADR 033): dated batches, at the item's average cost at the store
  expired_stock_value: { label: 'Expired', unit: 'money', better: 'down' },
  expiring_stock_value: { label: 'Expiring within 3 days', unit: 'money', better: 'down' },
  // labour (R-3, ADR 030): only for people who see labour cost
  splh: {
    label: 'Sales per hour worked',
    unit: 'money',
    better: 'up',
    hint: 'Sales divided by hours worked: how much each hour of labour brings in.',
  },
  labour_cost: { label: 'People cost', unit: 'money', better: 'down' },
  // ADR 042: shares of the total cost (materials + people), adding up to 100
  labour_pct: {
    label: 'People cost %',
    unit: 'pct',
    better: 'down',
    hint: "People's share of the total cost (materials plus people).",
  },
  materials_pct: {
    label: 'Materials %',
    unit: 'pct',
    hint: 'Food, drinks and losses together, as a share of the total cost.',
  },
  prime_cost: {
    label: 'Total cost (prime cost)',
    unit: 'money',
    better: 'down',
    hint: 'Materials plus people: the two big costs added together.',
  },
  // People
  headcount: { label: 'Headcount', unit: 'count' },
  joiners: { label: 'Joined', unit: 'count' },
  inactive: { label: 'Left or inactive', unit: 'count' },
  on_time_pct: { label: 'Shifts on time', unit: 'pct', better: 'up' },
  overtime_hours: {
    label: 'Overtime',
    unit: 'hours',
    better: 'down',
    hint: 'Hours worked beyond the contracted hours.',
  },
  leave_days: { label: 'Leave taken', unit: 'days' },
  swaps: { label: 'Shift swaps', unit: 'count' },
  leave_balance_days: { label: 'Leave not yet taken', unit: 'days' },
  leave_liability: {
    label: 'Its value (leave liability)',
    unit: 'money',
    hint: 'What the unused leave would cost if paid out.',
  },
  // central kitchen
  batches: { label: 'Batches made', unit: 'count' },
  made_value: { label: 'Value made', unit: 'money' },
  ingredients_over: { label: 'Ingredients over the recipe', unit: 'money', better: 'down' },
  expired_value: { label: 'Expired, thrown away', unit: 'money', better: 'down' },
  expired_pct: { label: 'Expired of what was made', unit: 'pct', better: 'down' },
  transfers: { label: 'Transfers sent', unit: 'count' },
  requested_value: { label: 'Asked for', unit: 'money' },
  dispatched_value: { label: 'Sent', unit: 'money' },
  fill_pct: { label: 'Filled', unit: 'pct', better: 'up' },
  transit_loss: { label: 'Lost in transit', unit: 'money', better: 'down' },
  in_transit_value: { label: 'On the way now', unit: 'money' },
  // a supplier's orders and a store's transfers, opened as trends (RPT-12)
  orders: { label: 'Orders', unit: 'count' },
  ordered_value: { label: 'Ordered', unit: 'money' },
  received_value: { label: 'Received', unit: 'money' },
  not_delivered: { label: 'Not delivered', unit: 'count', better: 'down' },
};

/** The sections of each report, in order (a measure missing from the data is skipped). */
/**
 * The three or four figures a report opens with (UX-7): drawn large, with the target.
 * Everything else sits under "More figures". A report with none shows all, as before.
 */
export const HEADLINE: Readonly<Partial<Record<ReportCode, readonly string[]>>> = {
  outlet_flash: ['sales', 'food_cost_pct', 'labour_pct', 'task_pct'],
  department: ['worked_hours', 'open_slots', 'task_pct', 'overdue'],
  my_week: ['shifts', 'worked_hours', 'late', 'tasks_done'],
  cost_of_sales: ['food_cost_pct', 'bar_cost_pct', 'count_loss', 'not_counted'],
  stock_position: ['stock_value', 'expired_stock_value', 'expiring_stock_value', 'days_on_hand'],
  people: ['headcount', 'on_time_pct', 'late', 'overtime_hours'],
  central_kitchen: ['made_value', 'expired_pct', 'fill_pct', 'transit_loss'],
};

/** The headline rows that the data has, and the rest, each in its section order. */
export function splitHeadline(report: ReportCode, rows: readonly MeasureRow[]) {
  const head = HEADLINE[report];
  const all = SECTIONS[report].flatMap(([title, measures]) =>
    sectionRows(rows, measures).map((r) => ({ ...r, section: title })),
  );
  if (!head) return { headline: [], rest: all };
  const first = head.flatMap((m) => all.filter((r) => r.measure === m));
  return { headline: first, rest: all.filter((r) => !head.includes(r.measure)) };
}

export const SECTIONS: Readonly<Record<ReportCode, readonly [string, readonly string[]][]>> = {
  outlet_flash: [
    ['Sales', ['sales', 'food_sales', 'bar_sales']],
    ['Cost (recipe)', ['food_cost_pct', 'bar_cost_pct']],
    ['Labour', ['labour_cost', 'prime_cost', 'labour_pct', 'materials_pct', 'splh']],
    ['Stock', ['wastage', 'wastage_pct', 'stock_value']],
    ['People', ['scheduled_hours', 'worked_hours', 'open_slots', 'late', 'no_shows']],
    ['Tasks', ['task_pct', 'tasks_due', 'overdue', 'flagged']],
  ],
  department: [
    [
      'People',
      [
        'shifts',
        'scheduled_hours',
        'worked_hours',
        'open_slots',
        'late',
        'no_shows',
        'labour_cost',
      ],
    ],
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
    ['Expiry', ['expired_stock_value', 'expiring_stock_value']],
    ['Dead stock', ['dead_items', 'dead_value']],
  ],
  people: [
    ['Team', ['headcount', 'joiners', 'inactive']],
    [
      'Shifts',
      ['shifts', 'on_time_pct', 'late', 'no_shows', 'worked_hours', 'overtime_hours', 'swaps'],
    ],
    ['Leave', ['leave_days', 'leave_balance_days', 'leave_liability']],
  ],
  central_kitchen: [
    ['Production', ['batches', 'made_value', 'ingredients_over', 'expired_value', 'expired_pct']],
    [
      'To the outlets',
      ['transfers', 'requested_value', 'dispatched_value', 'fill_pct', 'transit_loss'],
    ],
    ['Now', ['in_transit_value']],
  ],
  // lists, not measures
  league: [],
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

// ---------------------------------------------------------------------------------------
// Where the money went (R-3, ADR 030): the parts of the cost, each in ₹ and % of the total
// cost (ADR 042)
// ---------------------------------------------------------------------------------------

export type CostPart =
  | 'food_recipe'
  | 'bar_recipe'
  | 'expired'
  | 'transit_loss'
  | 'wastage_other'
  | 'other_use'
  | 'count_loss'
  | 'materials'
  | 'labour_hourly'
  | 'labour_salary'
  | 'labour'
  | 'prime';

/** The parts in order; totals are shown in bold, the parts under them indented. */
export const COST_PARTS: readonly { part: CostPart; label: string; total?: boolean }[] = [
  { part: 'food_recipe', label: 'Food, by the recipes' },
  { part: 'bar_recipe', label: 'Drinks, by the recipes' },
  { part: 'expired', label: 'Expired, thrown away' },
  { part: 'transit_loss', label: 'Lost in transit' },
  { part: 'wastage_other', label: 'Other wastage' },
  { part: 'other_use', label: 'Other use (staff meals, tastings)' },
  { part: 'count_loss', label: 'Lost at the count' },
  { part: 'materials', label: 'Raw materials', total: true },
  { part: 'labour_hourly', label: 'Hourly staff' },
  { part: 'labour_salary', label: 'Salaried staff' },
  { part: 'labour', label: 'People', total: true },
  { part: 'prime', label: 'Total cost (prime cost)', total: true },
];

export interface CostPartRow {
  part: string;
  value: string | null;
  pct: string | null;
}

/** The parts the data has, with labels, in order. */
export function costParts(rows: readonly CostPartRow[]) {
  const by = new Map(rows.map((r) => [r.part, r]));
  return COST_PARTS.flatMap((p) => {
    const r = by.get(p.part);
    return r ? [{ ...p, value: r.value, pct: r.pct }] : [];
  });
}

export interface CostShare {
  key: 'food' | 'drinks' | 'losses' | 'people';
  label: string;
  pct: number;
}

const LOSS_PARTS = ['expired', 'transit_loss', 'wastage_other', 'other_use', 'count_loss'];

/**
 * The drawn bar of Where the money went (UX-7): food, drinks, losses and people, each a
 * share of the total cost, so they add up to 100. Nothing for a part with no cost, and
 * People only where the data has it (the person sees labour cost).
 */
export function costShares(rows: readonly CostPartRow[]): CostShare[] {
  const pct = (part: string) => {
    const r = rows.find((x) => x.part === part);
    return r && r.pct !== null && Number.isFinite(Number(r.pct)) ? Number(r.pct) : null;
  };
  const losses = LOSS_PARTS.reduce((a, p) => a + (pct(p) ?? 0), 0);
  const out: CostShare[] = [
    { key: 'food', label: 'Food', pct: pct('food_recipe') ?? 0 },
    { key: 'drinks', label: 'Drinks', pct: pct('bar_recipe') ?? 0 },
    { key: 'losses', label: 'Wastage and losses', pct: losses },
    { key: 'people', label: 'People', pct: pct('labour') ?? 0 },
  ];
  return out.filter((x) => x.pct > 0);
}

const FLASH_PARTS: Readonly<Record<string, CostPart>> = {
  cost_food_recipe: 'food_recipe',
  cost_bar_recipe: 'bar_recipe',
  cost_expired: 'expired',
  cost_transit_loss: 'transit_loss',
  cost_wastage_other: 'wastage_other',
  cost_other_use: 'other_use',
  cost_count_loss: 'count_loss',
  cost_materials: 'materials',
  labour_hourly: 'labour_hourly',
  labour_salary: 'labour_salary',
  labour_cost: 'labour',
  prime_cost: 'prime',
};

/**
 * The same parts from Outlet today's measures, each as a share of the total cost: materials
 * plus people where the person sees labour cost, materials alone otherwise (ADR 042).
 */
export function flashCostParts(rows: readonly MeasureRow[]): CostPartRow[] {
  const num = (m: string) => {
    const v = rows.find((r) => r.measure === m)?.value;
    return v === null || v === undefined ? NaN : Number(v);
  };
  const materials = num('cost_materials');
  const labour = num('labour_cost');
  const total = Number.isFinite(labour) ? materials + labour : materials;
  return rows.flatMap((r) => {
    const part = FLASH_PARTS[r.measure];
    if (!part) return [];
    const v = r.value === null ? NaN : Number(r.value);
    const pct =
      Number.isFinite(v) && Number.isFinite(total) && total !== 0
        ? ((v * 100) / total).toFixed(1)
        : null;
    return [{ part, value: r.value, pct }];
  });
}

/** A period of at most 93 days (the labour and People reports' limit), ending at `to`. */
export function capRange(from: string, to: string, days = 93): { from: string; to: string } {
  const earliest = shift(to, -(days - 1));
  return { from: from < earliest ? earliest : from, to };
}

// ---------------------------------------------------------------------------------------
// The league table (R-4, ADR 031)
// ---------------------------------------------------------------------------------------

export interface LeagueRow {
  outlet_id: string;
  code: string;
  name: string;
  sales: string;
  food_pct: string | null;
  drink_pct: string | null;
  labour_pct: string | null;
  materials_pct: string | null;
  food_share: string | null;
  drink_share: string | null;
  losses_share: string | null;
  wastage_pct: string | null;
  tasks_pct: string | null;
}

export type LeagueColumn = Exclude<
  keyof LeagueRow,
  'outlet_id' | 'code' | 'name' | 'food_share' | 'drink_share' | 'losses_share'
>;

/** The columns, in order; a cost is better low, tasks and sales better high. */
/** Each league column is a figure of the outlet's own report, which opens its trend. */
export const LEAGUE_MEASURE: Readonly<Record<LeagueColumn, string>> = {
  sales: 'sales',
  food_pct: 'food_cost_pct',
  drink_pct: 'bar_cost_pct',
  labour_pct: 'labour_pct',
  materials_pct: 'materials_pct',
  wastage_pct: 'wastage_pct',
  tasks_pct: 'task_pct',
};

export const LEAGUE_COLUMNS: readonly {
  key: LeagueColumn;
  label: string;
  better: 'up' | 'down';
  /** what the % is a share of, in small type under the label: one base per column (UX-7) */
  basis?: string;
}[] = [
  { key: 'sales', label: 'Sales', better: 'up' },
  { key: 'food_pct', label: 'Food cost', better: 'down', basis: 'of food sales' },
  { key: 'drink_pct', label: 'Drinks cost', better: 'down', basis: 'of drinks sales' },
  { key: 'labour_pct', label: 'People cost %', better: 'down', basis: 'of total cost' },
  { key: 'materials_pct', label: 'Materials %', better: 'down', basis: 'of total cost' },
  { key: 'wastage_pct', label: 'Wastage', better: 'down', basis: 'of sales' },
  { key: 'tasks_pct', label: 'Tasks on time', better: 'up', basis: 'of tasks due' },
];

export function isLeagueColumn(s: string | undefined): s is LeagueColumn {
  return LEAGUE_COLUMNS.some((c) => c.key === s);
}

/**
 * Best first by the column asked for (sales by default): the lowest cost, the highest sales
 * or task score. Outlets with no figure go last, then by name.
 */
export function sortLeague<T extends LeagueRow>(
  rows: readonly T[],
  column: LeagueColumn = 'sales',
): T[] {
  const better = LEAGUE_COLUMNS.find((c) => c.key === column)!.better;
  const val = (r: T) => (r[column] === null || r[column] === '' ? null : Number(r[column]));
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x === null && y === null) return a.name.localeCompare(b.name);
    if (x === null) return 1;
    if (y === null) return -1;
    if (x === y) return a.name.localeCompare(b.name);
    return better === 'up' ? y - x : x - y;
  });
}

// ---------------------------------------------------------------------------------------
// Menu engineering periods and wording (RPT-13, ADR 033)
// ---------------------------------------------------------------------------------------

/** Menu engineering is for long periods: the last 3, 6, 9 or 12 months. */
export const MENU_MONTHS = [3, 6, 9, 12] as const;
export type MenuMonths = (typeof MENU_MONTHS)[number];

export function menuMonths(s: string | undefined): MenuMonths {
  const n = Number(s);
  return (MENU_MONTHS as readonly number[]).includes(n) ? (n as MenuMonths) : 3;
}

/** The last `months` months ending today: from the day after the same date that many
 * months back (the month's last day when it has no such date). A year is 365 or 366 days. */
export function monthsRange(today: string, months: number): { from: string; to: string } {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const back = new Date(Date.UTC(y, m - 1 - months, 1));
  const last = new Date(Date.UTC(back.getUTCFullYear(), back.getUTCMonth() + 1, 0)).getUTCDate();
  back.setUTCDate(Math.min(d, last));
  return { from: shift(back.toISOString().slice(0, 10), 1), to: today };
}

/** A dish in plain words: "Price ₹525.00 · cost ₹207.50 · margin ₹317.50 a serve" and
 * "12 sold · 20.4% of drinks sold". */
export function dishWords(
  d: {
    price: string | null;
    cost: string | null;
    margin: string | null;
    sold: string;
    mix_pct: string | null;
  },
  menu: string,
  money: (v: string | null) => string | null,
): { money: string; share: string } {
  const what = menu === 'Bar' ? 'drinks' : 'dishes';
  return {
    money: `Price ${money(d.price) ?? '–'} · cost ${money(d.cost) ?? '–'} · margin ${
      money(d.margin) ?? '–'
    } a serve`,
    share: `${Number(d.sold)} sold · ${d.mix_pct ?? '0'}% of ${what} sold`,
  };
}

// ---------------------------------------------------------------------------------------
// Trends (RPT-12, ADR 041)

/** A trend covers the same periods as Menu engineering: the last 3, 6, 9 or 12 months. */
export const TREND_MONTHS = MENU_MONTHS;
export const trendMonths = menuMonths;

/** By week (the default: a narrow screen holds 13 to 53 of them) or by month. */
export const TREND_GRAINS = ['week', 'month'] as const;
export type TrendGrain = (typeof TREND_GRAINS)[number];

export function trendGrain(s: string | undefined): TrendGrain {
  return s === 'month' ? 'month' : 'week';
}

/** A line shows a cost going up and down best; bars show the parts of a total. */
export const TREND_CHARTS = ['line', 'bar'] as const;
export type TrendChartKind = (typeof TREND_CHARTS)[number];

export function trendChart(s: string | undefined): TrendChartKind {
  return s === 'bar' ? 'bar' : 'line';
}

/** The last `months` months to today, from the Monday (by week) or the 1st (by month) the
 * period starts in, so the first point is a whole week or month. */
export function trendRange(
  months: number,
  by: TrendGrain,
  today: string,
): { from: string; to: string } {
  const start = monthsRange(today, months).from;
  return { from: by === 'week' ? weekStart(start) : `${start.slice(0, 8)}01`, to: today };
}

/** The settings of a trend page, read from its link. */
export function trendSettings(sp: { months?: string; by?: string; chart?: string }): {
  months: MenuMonths;
  by: TrendGrain;
  chart: TrendChartKind;
} {
  return { months: trendMonths(sp.months), by: trendGrain(sp.by), chart: trendChart(sp.chart) };
}

/** The figures of each report that open a trend (rpt.measure_trend says the same). */
export const TREND_MEASURES: Readonly<Partial<Record<ReportCode, ReadonlySet<string>>>> = {
  outlet_flash: new Set([
    'sales',
    'food_sales',
    'bar_sales',
    'food_cost_pct',
    'bar_cost_pct',
    'wastage',
    'wastage_pct',
    'stock_value',
    'scheduled_hours',
    'worked_hours',
    'open_slots',
    'late',
    'no_shows',
    'task_pct',
    'tasks_due',
    'tasks_done',
    'overdue',
    'flagged',
    'splh',
    'labour_cost',
    'labour_pct',
    'materials_pct',
    'prime_cost',
  ]),
  department: new Set([
    'shifts',
    'scheduled_hours',
    'worked_hours',
    'open_slots',
    'late',
    'no_shows',
    'labour_cost',
    'task_pct',
    'tasks_due',
    'tasks_done',
    'tasks_on_time',
    'overdue',
    'flagged',
    'wastage',
    'stock_value',
  ]),
  cost_of_sales: new Set([
    'food_sales',
    'bar_sales',
    'food_cost_pct',
    'food_recipe_pct',
    'bar_cost_pct',
    'bar_recipe_pct',
    'count_loss',
    'beyond_tolerance',
    'wastage',
    'expired',
  ]),
  people: new Set([
    'joiners',
    'shifts',
    'late',
    'no_shows',
    'on_time_pct',
    'worked_hours',
    'overtime_hours',
    'leave_days',
    'swaps',
  ]),
  central_kitchen: new Set([
    'batches',
    'made_value',
    'ingredients_over',
    'expired_value',
    'expired_pct',
    'transfers',
    'requested_value',
    'dispatched_value',
    'fill_pct',
    'transit_loss',
  ]),
  stock_position: new Set(['stock_value']),
};

/** Where a report's figure opens its trend, or null when it has none. */
export function trendHref(
  report: ReportCode,
  node: string,
  measure: string,
  extra?: { key?: string; name?: string; months?: number },
): string | null {
  const set = TREND_MEASURES[report];
  if (!extra?.key && !set?.has(measure)) return null;
  const q = new URLSearchParams({ report, node, measure });
  if (extra?.key) q.set('key', extra.key);
  if (extra?.name) q.set('name', extra.name);
  if (extra?.months) q.set('months', String(extra.months));
  return `/reports/trend?${q.toString()}`;
}

/** A period's label: "Week of 28 Sep" or "Sep 2026" (always "Sep", never "Sept"). */
export function trendLabel(by: TrendGrain | 'day', period: string): string {
  const d = new Date(`${period}T00:00:00Z`);
  const sep = (x: string) => x.replace('Sept', 'Sep');
  if (by === 'month') {
    return sep(d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }));
  }
  const day = sep(
    d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
  );
  if (by === 'week') return `Week of ${day}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })} ${day}`;
}
