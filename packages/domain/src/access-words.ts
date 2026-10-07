import { DOMAINS, type Access } from './access';

// Plain words for each domain, for the profile's access summary (ADR 018): "Change:
// rosters, attendance. See: people". Derived domains are the same data seen through the
// stores linked to a department.

export const DOMAIN_WORDS: Readonly<Record<string, string>> = {
  STOCK_LEVELS: 'stock levels',
  STOCK_ADJUSTMENTS: 'stock counts and wastage',
  STOCK_CHECK: 'the stock check',
  PURCHASE_ORDERS: 'purchase orders',
  BILLS: 'vendor bills',
  TRANSFERS: 'transfers',
  RECIPES: 'recipes',
  RECIPES_TEAM: 'your team’s recipes',
  MENU: 'menus, prices and costs',
  PRODUCTION: 'prep batches',
  PRODUCTION_TEAM: 'your team’s prep batches',
  SALES: 'daily sales',
  POS_IMPORT: 'the POS sales import',
  WORKERS: 'people',
  COMPENSATION: 'pay',
  LABOUR_COST: 'labour cost totals',
  ROSTER: 'rosters',
  ATTENDANCE_SELFIES: 'clock-in selfies',
  ATTENDANCE: 'attendance',
  LEAVE: 'leave',
  EVENTS: 'events',
  SHIFT_SWAPS: 'shift swaps',
  TASKS: 'tasks',
  COMPLIANCE: 'licences and the compliance calendar',
  CHECKLIST_TEMPLATES: 'checklists',
  MAINTENANCE: 'maintenance requests',
  BRIEFING: "today's briefing note",
  MINIBAR: "the rooms' minibars",
  AI_RECOMMENDATIONS: 'AI suggestions',
  DERIVED_STOCK_LEVELS: 'stock levels of linked stores',
  DERIVED_STOCK_ADJUSTMENTS: 'stock counts of linked stores',
  DERIVED_PURCHASE_ORDERS: 'purchase orders of linked stores',
  DERIVED_TRANSFERS: 'transfers of linked stores',
  DERIVED_MENU: 'menus and costs of linked outlets',
  DERIVED_PRODUCTION: 'prep batches of linked stores',
  DERIVED_SALES: 'sales of linked outlets',
  AUDIT: 'the audit trail',
  NOTIFICATIONS: 'your notifications',
  USER_ACCESS: 'users and their access',
  COMPANY_SETTINGS: 'company settings',
  SECURITY_ROLES: 'security roles',
  WF_CONFIG: 'approval settings',
  REPORTS: 'company reports',
};

export interface AccessSummary {
  change: string[];
  see: string[];
}

/** The domains of one grant as words, in the product's domain order. */
export function summariseAccess(
  domains: readonly { domain: string; access: Access }[],
): AccessSummary {
  const by = new Map(domains.map((d) => [d.domain, d.access]));
  const out: AccessSummary = { change: [], see: [] };
  for (const d of DOMAINS) {
    const a = by.get(d.code);
    if (!a) continue;
    (a === 'modify' ? out.change : out.see).push(DOMAIN_WORDS[d.code] ?? d.code.toLowerCase());
  }
  return out;
}

/** "Test Hotel & Bar 1.0 and everything under it", or "Yourself" for self-service. */
export function grantPlace(place: string | null, includeDescendants: boolean | null): string {
  if (place === null) return 'Yourself, wherever you work';
  return includeDescendants ? `${place} and everything under it` : `${place} only`;
}
