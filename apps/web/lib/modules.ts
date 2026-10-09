// Building blocks on or off per customer (ADR 026, 085). A switched-off block's domains are
// left out of what the screens see, so its tabs, links and Home cards disappear through the
// same checks that hide anything else the person can't open. The database says no as well:
// core.can refuses a switched-off block's domains, and core.require_module says MODULE_OFF.

import { MODULE_CODES, MODULES, resolveModules, type ModuleCode } from '@outlet-ops/domain';

/** The domains whose screens belong to each block (the manifest's). */
export const MODULE_DOMAINS: Readonly<Record<ModuleCode, readonly string[]>> = Object.fromEntries(
  MODULES.map((m): [ModuleCode, readonly string[]] => [m.code, m.domains]),
) as Record<ModuleCode, readonly string[]>;

/** Report figures that come from sales: hidden when Menu and sales is off. */
export const SALES_MEASURES: ReadonlySet<string> = new Set([
  'sales',
  'food_sales',
  'bar_sales',
  'food_cost_pct',
  'bar_cost_pct',
  'wastage_pct',
  // from the sales too (R-3): the cost parts, the shares of the total cost and prime cost
  'splh',
  'labour_pct',
  'materials_pct',
  'prime_cost',
  'cost_food_recipe',
  'cost_bar_recipe',
  'cost_expired',
  'cost_transit_loss',
  'cost_wastage_other',
  'cost_other_use',
  'cost_count_loss',
  'cost_materials',
]);

/** The blocks that are on, from core.my_modules() rows; a block is off with one it needs. */
export function modulesOn(rows: readonly { code: string; on: boolean }[]): Set<ModuleCode> {
  const off = new Set(rows.filter((r) => !r.on).map((r) => r.code));
  return resolveModules(MODULE_CODES.filter((c) => !off.has(c)));
}

/** The person's domains without those of switched-off modules. */
export function withModules<V>(
  domains: ReadonlyMap<string, V>,
  on: ReadonlySet<ModuleCode>,
): Map<string, V> {
  const hidden = new Set(MODULE_CODES.filter((m) => !on.has(m)).flatMap((m) => MODULE_DOMAINS[m]));
  return new Map([...domains].filter(([d]) => !hidden.has(d)));
}
