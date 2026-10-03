// Company settings (R-4, ADR 031; PO-4, ADR 032): read with core.company_settings(), changed
// by the Account Owner with core.set_company_settings(), which checks every value. Pure: the
// defaults, and how a figure reads against its target.

export type TargetKey = 'food' | 'drink' | 'labour' | 'prime' | 'wastage' | 'tasks';

export interface CompanySettings {
  targets: Record<TargetKey, number>;
  menu_popular_pct: number;
  overtime_multiplier: number;
  po_send_prices: boolean;
}

export const DEFAULT_SETTINGS: CompanySettings = {
  targets: { food: 30, drink: 22, labour: 25, prime: 60, wastage: 2, tasks: 90 },
  menu_popular_pct: 70,
  overtime_multiplier: 1,
  po_send_prices: false,
};

/** The targets in the order Admin → Settings shows them, and which way is good. */
export const TARGETS: readonly { key: TargetKey; label: string; better: 'up' | 'down' }[] = [
  { key: 'food', label: 'Food cost', better: 'down' },
  { key: 'drink', label: 'Drinks cost', better: 'down' },
  { key: 'labour', label: 'People cost', better: 'down' },
  { key: 'prime', label: 'Prime cost', better: 'down' },
  { key: 'wastage', label: 'Wastage', better: 'down' },
  { key: 'tasks', label: 'Tasks done on time', better: 'up' },
];

/** The measure each target applies to, in every report that shows it. */
export const TARGET_OF: Readonly<Record<string, TargetKey>> = {
  food_cost_pct: 'food',
  food_pct: 'food',
  bar_cost_pct: 'drink',
  drink_pct: 'drink',
  labour_pct: 'labour',
  prime_cost_pct: 'prime',
  prime_pct: 'prime',
  wastage_pct: 'wastage',
  task_pct: 'tasks',
  tasks_pct: 'tasks',
};

/** A figure shows red only when it is worse than its target by more than this (points). */
export const TOLERANCE_PTS = 2;

export type TargetState = 'bad' | 'ok' | 'none';

/** A percentage against its target: bad only when worse by more than 2 points. */
export function vsTarget(
  measure: string,
  value: string | number | null | undefined,
  targets: Record<TargetKey, number>,
): { target: number | null; state: TargetState } {
  const key = TARGET_OF[measure];
  if (!key) return { target: null, state: 'none' };
  const target = targets[key];
  if (value === null || value === undefined || value === '') return { target, state: 'none' };
  const v = Number(value);
  if (!Number.isFinite(v)) return { target, state: 'none' };
  const better = TARGETS.find((t) => t.key === key)!.better;
  const worseBy = better === 'down' ? v - target : target - v;
  return { target, state: worseBy > TOLERANCE_PTS ? 'bad' : 'ok' };
}

/** What the database returned, with anything missing taken from the defaults. */
export function readSettings(raw: unknown): CompanySettings {
  const r = (raw ?? {}) as Partial<CompanySettings>;
  return {
    targets: { ...DEFAULT_SETTINGS.targets, ...(r.targets ?? {}) },
    menu_popular_pct: r.menu_popular_pct ?? DEFAULT_SETTINGS.menu_popular_pct,
    overtime_multiplier: r.overtime_multiplier ?? DEFAULT_SETTINGS.overtime_multiplier,
    po_send_prices: r.po_send_prices ?? DEFAULT_SETTINGS.po_send_prices,
  };
}
