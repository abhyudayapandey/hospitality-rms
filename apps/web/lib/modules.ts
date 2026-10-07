// Modules on or off per company (UX-3b, ADR 026). A switched-off module's domains are left
// out of what the screens see, so its tabs, links and Home cards disappear through the same
// checks that hide anything else the person can't open. This is presentation only: the
// database keeps the data and the access rules, and refuses the module's writes with
// MODULE_OFF (core.require_module, and the wf.request trigger for leave and swaps).

import { MODULE_CODES, type ModuleCode } from '@outlet-ops/domain';

/** The domains whose screens belong to each module. Prep lists and Checklists are task tabs. */
export const MODULE_DOMAINS: Readonly<Record<ModuleCode, readonly string[]>> = {
  events: ['EVENTS'],
  swaps: ['SHIFT_SWAPS'],
  leave: ['LEAVE'],
  production: ['PRODUCTION', 'PRODUCTION_TEAM', 'DERIVED_PRODUCTION'],
  prep_lists: [],
  checklists: ['CHECKLIST_TEMPLATES'],
  maintenance: ['MAINTENANCE'],
  compliance: ['COMPLIANCE'],
  menu_sales: ['MENU', 'DERIVED_MENU', 'SALES', 'DERIVED_SALES', 'POS_IMPORT'],
};

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

/** The modules that are on, from core.my_modules() rows; Prep lists only with Production. */
export function modulesOn(rows: readonly { code: string; on: boolean }[]): Set<ModuleCode> {
  const off = new Set(rows.filter((r) => !r.on).map((r) => r.code));
  const on = new Set(MODULE_CODES.filter((c) => !off.has(c)));
  if (!on.has('production')) on.delete('prep_lists');
  return on;
}

/** The person's domains without those of switched-off modules. */
export function withModules<V>(
  domains: ReadonlyMap<string, V>,
  on: ReadonlySet<ModuleCode>,
): Map<string, V> {
  const hidden = new Set(MODULE_CODES.filter((m) => !on.has(m)).flatMap((m) => MODULE_DOMAINS[m]));
  return new Map([...domains].filter(([d]) => !hidden.has(d)));
}
