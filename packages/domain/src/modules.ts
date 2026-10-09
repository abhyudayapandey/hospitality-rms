// Building blocks (ADR 026, 067, 085): every group of functionality a customer can have or not.
// To people they are blocks; in code and the database they are modules. Each block's manifest
// says what it is, the bundle it is sold in, the blocks it can't work without, the outlets it
// fits and the access domains it owns. The base (places and people, access, To do, approvals,
// notifications, Home, Me, Admin, onboarding and the reports shell) has no switch: its domains
// are BASE_DOMAINS. The same codes as core.module_codes(), core.module_bundle(),
// core.module_needs() and core.domain_module() in the database; a test keeps them equal.
//
// Order matters: a block comes after every block it needs (core.tenant_modules resolves them
// in this order).

export type ModuleFit = 'any' | 'hotel' | 'alcohol';

interface ModuleDef {
  code: string;
  name: string;
  /** one plain line: what it is, and what goes when it is off */
  what: string;
  bundle: string;
  /** blocks it can't work without: it is off whenever one of them is */
  needs?: readonly string[];
  fits?: ModuleFit;
  /** the access domains it owns; core.can says no to them while it is off */
  domains: readonly string[];
  /** on for a customer that hasn't said (default true) */
  defaultOn?: false;
}

export const MODULES = [
  // Stock & buying
  {
    code: 'stock',
    name: 'Stores & stock',
    what: 'Stores, items and par, stock checks, stock requests between stores, wastage and expiry.',
    bundle: 'stock_buying',
    domains: [
      'STOCK_LEVELS',
      'STOCK_ADJUSTMENTS',
      'STOCK_CHECK',
      'TRANSFERS',
      'DERIVED_STOCK_LEVELS',
      'DERIVED_STOCK_ADJUSTMENTS',
      'DERIVED_TRANSFERS',
    ],
  },
  {
    code: 'buying',
    name: 'Supply requests & orders',
    what: 'Supply requests, purchase orders, receiving and vendor bills.',
    bundle: 'stock_buying',
    needs: ['stock'],
    domains: ['PURCHASE_ORDERS', 'BILLS', 'DERIVED_PURCHASE_ORDERS'],
  },
  // Kitchen & bar
  {
    code: 'recipes',
    name: 'Recipes & costing',
    what: 'Recipes and prep items with their methods, and what each dish costs to make.',
    bundle: 'kitchen_bar',
    needs: ['stock'],
    domains: ['RECIPES', 'RECIPES_TEAM'],
  },
  {
    code: 'production',
    name: 'Production',
    what: 'Batches made in the kitchen or bar, with expiry.',
    bundle: 'kitchen_bar',
    needs: ['recipes'],
    domains: ['PRODUCTION', 'PRODUCTION_TEAM', 'DERIVED_PRODUCTION'],
  },
  {
    code: 'prep_lists',
    name: 'Prep lists',
    what: 'Daily prep tasks from par levels. Needs Production.',
    bundle: 'kitchen_bar',
    needs: ['production'],
    domains: [],
  },
  {
    code: 'menu_sales',
    name: 'Menu and sales',
    what: 'Menu costs and prices, daily sales and variance. Off: no sales figures in reports.',
    bundle: 'kitchen_bar',
    needs: ['recipes'],
    domains: ['MENU', 'DERIVED_MENU', 'SALES', 'DERIVED_SALES', 'POS_IMPORT'],
  },
  // People
  {
    code: 'roster',
    name: 'Roster',
    what: "Shifts by week and by person, and everyone's own week.",
    bundle: 'people',
    domains: ['ROSTER'],
  },
  {
    code: 'clock_in',
    name: 'Clock-in',
    what: 'Clocking in and out at the outlet with a selfie, and attendance exceptions.',
    bundle: 'people',
    needs: ['roster'],
    domains: ['ATTENDANCE', 'ATTENDANCE_SELFIES'],
  },
  {
    code: 'pay',
    name: 'Salaries & labour cost',
    what: 'Pay rates, and labour cost in the reports. Off: total cost is materials only.',
    bundle: 'people',
    needs: ['roster'],
    domains: ['COMPENSATION', 'LABOUR_COST'],
  },
  {
    code: 'leave',
    name: 'Leave',
    what: 'Leave requests, approvals and balances.',
    bundle: 'people',
    domains: ['LEAVE'],
  },
  {
    code: 'swaps',
    name: 'Shift swaps',
    what: 'Staff offer a shift to a colleague; the manager approves.',
    bundle: 'people',
    needs: ['roster'],
    domains: ['SHIFT_SWAPS'],
  },
  // Daily work
  {
    code: 'checklists',
    name: 'Checklists',
    what: 'Opening, closing and temperature rounds on a schedule.',
    bundle: 'daily_work',
    domains: ['CHECKLIST_TEMPLATES'],
  },
  {
    code: 'maintenance',
    name: 'Maintenance',
    what: 'Report a problem; engineering assigns and fixes it.',
    bundle: 'daily_work',
    domains: ['MAINTENANCE'],
  },
  {
    code: 'briefing',
    name: "Today's briefing",
    what: 'A note for each part of the day that everyone at the outlet reads on Home.',
    bundle: 'daily_work',
    domains: ['BRIEFING'],
  },
  // Hotel
  {
    code: 'minibars',
    name: 'Room minibars',
    what: 'Minibar checks room by room, refilled from a store and charged to the guest.',
    bundle: 'hotel',
    needs: ['stock'],
    fits: 'hotel',
    domains: ['MINIBAR'],
  },
  // Events & compliance
  {
    code: 'events',
    name: 'Events',
    what: 'Banquets and functions: covers, staff and stock needed.',
    bundle: 'events_compliance',
    domains: ['EVENTS'],
  },
  {
    code: 'compliance',
    name: 'Compliance',
    what: 'Licences with their renewals, and the compliance calendar with proof.',
    bundle: 'events_compliance',
    domains: ['COMPLIANCE'],
    defaultOn: false,
  },
] as const satisfies readonly ModuleDef[];

export type ModuleCode = (typeof MODULES)[number]['code'];
export type Module = (typeof MODULES)[number];

export const MODULE_CODES: readonly ModuleCode[] = MODULES.map((m) => m.code);

/**
 * The domains with no switch: places and people, access, To do, approvals, notifications,
 * the audit log and the reports shell. Every other domain belongs to exactly one block.
 */
export const BASE_DOMAINS: readonly string[] = [
  'WORKERS',
  'TASKS',
  'NOTIFICATIONS',
  'AUDIT',
  'USER_ACCESS',
  'COMPANY_SETTINGS',
  'SECURITY_ROLES',
  'WF_CONFIG',
  'REPORTS',
  'AI_RECOMMENDATIONS',
];

export function isModuleCode(s: string): s is ModuleCode {
  return (MODULE_CODES as readonly string[]).includes(s);
}

export function moduleOf(code: ModuleCode): Module {
  return MODULES.find((m) => m.code === code)!;
}

/** What a block needs (nothing for most). */
export function needsOf(code: ModuleCode): readonly ModuleCode[] {
  const m = moduleOf(code);
  return 'needs' in m ? m.needs : [];
}

/** On for a customer that hasn't said: every block but Compliance. */
export function onByDefault(code: ModuleCode): boolean {
  const m = moduleOf(code);
  return !('defaultOn' in m && m.defaultOn === false);
}

const DOMAIN_MODULE = new Map<string, ModuleCode>(
  MODULES.flatMap((m) => m.domains.map((d) => [d, m.code] as const)),
);

/** The block a domain belongs to; null for the base. */
export function moduleOfDomain(domain: string): ModuleCode | null {
  return DOMAIN_MODULE.get(domain) ?? null;
}

/**
 * The blocks that are on, from the switches as they stand: a block is on when it is switched
 * on and every block it needs is on (Prep lists go off with Production).
 */
export function resolveModules(switchedOn: Iterable<string>): Set<ModuleCode> {
  const want = new Set(switchedOn);
  const on = new Set<ModuleCode>();
  for (const m of MODULES) {
    if (want.has(m.code) && needsOf(m.code).every((n) => on.has(n))) on.add(m.code);
  }
  return on;
}
