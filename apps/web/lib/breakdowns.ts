// What is behind a figure (ADR 042): a trend opens the lists that make up its figure for one
// week or month, each in its own section (collapsed until tapped). Pure: which lists each
// figure has, and the period they cover. The rpt.bd_* functions check access.

import type { TrendGrain } from './reports';

export type BreakdownKind =
  'dishes' | 'wastage' | 'stock' | 'cost' | 'people' | 'tasks' | 'readings';

/** The reports each list opens from, as rpt.bd_* accept them. */
const OPENS_FROM: Readonly<Record<BreakdownKind, readonly string[]>> = {
  dishes: ['outlet_flash', 'cost_of_sales'],
  wastage: ['outlet_flash', 'department', 'cost_of_sales'],
  stock: ['outlet_flash', 'department', 'stock_position'],
  cost: ['outlet_flash'],
  people: ['outlet_flash', 'department', 'people'],
  tasks: ['outlet_flash', 'department'],
  readings: ['outlet_flash', 'department'],
};

/** The lists behind each figure, most telling first. */
const BEHIND: Readonly<Record<string, readonly BreakdownKind[]>> = {
  sales: ['dishes'],
  food_sales: ['dishes'],
  bar_sales: ['dishes'],
  food_cost_pct: ['dishes', 'wastage'],
  bar_cost_pct: ['dishes', 'wastage'],
  food_recipe_pct: ['dishes'],
  bar_recipe_pct: ['dishes'],
  splh: ['dishes', 'people'],
  wastage: ['wastage'],
  wastage_pct: ['wastage', 'dishes'],
  expired: ['wastage'],
  stock_value: ['stock'],
  expired_stock_value: ['stock'],
  expiring_stock_value: ['stock'],
  dead_value: ['stock'],
  used_value: ['stock'],
  labour_cost: ['cost', 'people'],
  labour_pct: ['cost', 'people'],
  materials_pct: ['cost', 'wastage'],
  prime_cost: ['cost', 'people'],
  scheduled_hours: ['people'],
  worked_hours: ['people'],
  open_slots: ['people'],
  shifts: ['people'],
  late: ['people'],
  no_shows: ['people'],
  on_time_pct: ['people'],
  overtime_hours: ['people'],
  task_pct: ['tasks'],
  tasks_due: ['tasks'],
  tasks_done: ['tasks'],
  tasks_on_time: ['tasks'],
  overdue: ['tasks'],
  flagged: ['readings', 'tasks'],
};

/** The lists a figure of a report opens, in order; none for a figure with no list. */
export function breakdownsFor(report: string, measure: string): BreakdownKind[] {
  return (BEHIND[measure] ?? []).filter((k) => OPENS_FROM[k].includes(report));
}

/** Titles, with the period added on the page. */
export const BREAKDOWN_TITLE: Readonly<Record<BreakdownKind, string>> = {
  dishes: 'Sales and recipe cost by dish',
  wastage: 'Wastage by item',
  stock: 'Stock held now, by item',
  cost: 'Where the money went',
  people: 'People: shifts, hours, late and no-shows',
  tasks: 'Tasks by person',
  readings: 'Flagged readings',
};

/** The last day of the week or month starting on `start` ('YYYY-MM-DD'). */
export function periodEnd(by: TrendGrain, start: string): string {
  const d = new Date(`${start}T00:00:00Z`);
  if (by === 'week') d.setUTCDate(d.getUTCDate() + 6);
  else d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}

/**
 * The period the lists cover: the one asked for (`at`) when the trend has it, else the
 * latest with a figure, else the latest. Its end is cut at `today`, the report's day.
 */
export function selectedPeriod(
  points: readonly { period: string; value: string | null }[],
  at: string,
  by: TrendGrain,
  today: string,
): { from: string; to: string } | null {
  if (points.length === 0) return null;
  const chosen =
    points.find((p) => p.period === at) ??
    [...points].reverse().find((p) => p.value !== null) ??
    points[points.length - 1]!;
  const end = periodEnd(by, chosen.period);
  return { from: chosen.period, to: end > today ? today : end };
}

/** Share of a whole, one decimal; null when there is no whole. */
export function share(part: number, whole: number): string | null {
  return whole > 0 ? ((part * 100) / whole).toFixed(1) : null;
}
