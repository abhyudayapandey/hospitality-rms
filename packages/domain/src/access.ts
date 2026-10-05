// Product-wide access definition (ADR 009): the access groups every customer gets, the
// domains, and what each group may do in each domain. The same for every customer; the
// workflow package's product sync writes it into each tenant (authoritative: rows not
// listed here are removed). docs/onboarding/test-data/PRODUCT_access_groups_REFERENCE.csv
// describes the groups in plain words; a test keeps the two in step.

export type Access = 'view' | 'modify';
export type Tree = 'org' | 'delivery' | 'self';

export interface DomainDef {
  code: string;
  tree: Tree;
  /** Administration, not business data: the only domains admin groups may hold. */
  admin?: true;
}

export const DOMAINS: readonly DomainDef[] = [
  { code: 'STOCK_LEVELS', tree: 'delivery' },
  { code: 'STOCK_ADJUSTMENTS', tree: 'delivery' },
  // the stock check: counting what is on the shelves against what should be there, and
  // seeing who verified what (INV-10, ADR 043); modify is the verifier's right
  { code: 'STOCK_CHECK', tree: 'delivery' },
  { code: 'PURCHASE_ORDERS', tree: 'delivery' },
  // vendor bills (BIL-1 to BIL-3, ADR 050): at the store, like the orders they pay for
  { code: 'BILLS', tree: 'delivery' },
  { code: 'TRANSFERS', tree: 'delivery' },
  // recipes and prep procedures where they are made or sold (no costs, ADR 014)
  { code: 'RECIPES', tree: 'delivery' },
  // the same through a department's linked store (kitchen staff -> kitchen store)
  { code: 'RECIPES_TEAM', tree: 'org' },
  // prices and costs; modify edits menus, prices and recipes
  { code: 'MENU', tree: 'delivery' },
  // recording prep batches where they are made (ADR 015)
  { code: 'PRODUCTION', tree: 'delivery' },
  // the same through a department's linked store, for items made there (ADR 016)
  { code: 'PRODUCTION_TEAM', tree: 'org' },
  // a day's sales per outlet (manual entry, later the POS import)
  { code: 'SALES', tree: 'delivery' },
  // importing the POS's end-of-day file, without reading the outlet's sales (ADR 039)
  { code: 'POS_IMPORT', tree: 'delivery' },
  { code: 'WORKERS', tree: 'org' },
  { code: 'COMPENSATION', tree: 'org' },
  // labour cost totals per department and outlet, never one person's pay; groups of fewer
  // than 3 paid people are folded together (ADR 030)
  { code: 'LABOUR_COST', tree: 'org' },
  { code: 'ROSTER', tree: 'org' },
  { code: 'ATTENDANCE', tree: 'org' },
  // clock-in selfies: HR, the head of the person's department and the person themselves; not the
  // GM or the area manager (ATT-7, ADR 045)
  { code: 'ATTENDANCE_SELFIES', tree: 'org' },
  { code: 'LEAVE', tree: 'org' },
  { code: 'EVENTS', tree: 'org' },
  { code: 'SHIFT_SWAPS', tree: 'org' },
  // tasks and checklists, maintenance requests (ADR 020)
  { code: 'TASKS', tree: 'org' },
  { code: 'CHECKLIST_TEMPLATES', tree: 'org' },
  { code: 'MAINTENANCE', tree: 'org' },
  { code: 'AI_RECOMMENDATIONS', tree: 'org' },
  { code: 'DERIVED_STOCK_LEVELS', tree: 'org' },
  { code: 'DERIVED_STOCK_ADJUSTMENTS', tree: 'org' },
  { code: 'DERIVED_PURCHASE_ORDERS', tree: 'org' },
  { code: 'DERIVED_TRANSFERS', tree: 'org' },
  { code: 'DERIVED_MENU', tree: 'org' },
  { code: 'DERIVED_PRODUCTION', tree: 'org' },
  { code: 'DERIVED_SALES', tree: 'org' },
  { code: 'AUDIT', tree: 'org' },
  { code: 'NOTIFICATIONS', tree: 'self' },
  { code: 'USER_ACCESS', tree: 'org', admin: true },
  { code: 'COMPANY_SETTINGS', tree: 'org', admin: true },
  { code: 'SECURITY_ROLES', tree: 'org', admin: true },
  { code: 'WF_CONFIG', tree: 'org', admin: true },
  // every report in the company, read-only: totals, never a single row of business data
  // (ADR 023); the Account Owner's only window on the numbers
  { code: 'REPORTS', tree: 'org', admin: true },
];

export type GroupKind = 'role' | 'admin' | 'user_based';

export interface GroupDef {
  code: string;
  name: string;
  kind: GroupKind;
  /** domain -> access; admin groups may only hold admin domains (enforced in SQL too) */
  grants: Readonly<Record<string, Access>>;
}

const v = 'view' as const;
const m = 'modify' as const;

export const ACCESS_GROUPS: readonly GroupDef[] = [
  {
    code: 'SELF',
    name: 'Self-service',
    kind: 'user_based',
    grants: {
      WORKERS: v,
      COMPENSATION: v,
      ROSTER: v,
      ATTENDANCE: m,
      LEAVE: m,
      SHIFT_SWAPS: m,
      ATTENDANCE_SELFIES: v,
      NOTIFICATIONS: v,
      TASKS: m,
      MAINTENANCE: m,
    },
  },
  {
    code: 'STAFF',
    name: 'Staff',
    kind: 'role',
    grants: { ROSTER: v, EVENTS: v, RECIPES_TEAM: v, MAINTENANCE: v },
  },
  {
    code: 'SUPERVISOR',
    name: 'Supervisor',
    kind: 'role',
    grants: {
      ROSTER: v,
      ATTENDANCE: v,
      EVENTS: v,
      RECIPES_TEAM: v,
      TASKS: m,
      CHECKLIST_TEMPLATES: v,
    },
  },
  {
    code: 'DEPARTMENT_HEAD',
    name: 'Department Head',
    kind: 'role',
    grants: {
      ROSTER: m,
      ATTENDANCE: m,
      ATTENDANCE_SELFIES: v,
      LEAVE: v,
      SHIFT_SWAPS: v,
      WORKERS: v,
      EVENTS: v,
      AI_RECOMMENDATIONS: v,
      RECIPES_TEAM: v,
      DERIVED_MENU: v,
      DERIVED_PRODUCTION: v,
      DERIVED_SALES: v,
      TASKS: m,
      CHECKLIST_TEMPLATES: m,
      MAINTENANCE: m,
    },
  },
  {
    // records batches at the department's store, for items made there; nothing else
    code: 'PRODUCTION_TEAM',
    name: 'Production Team',
    kind: 'role',
    grants: { PRODUCTION_TEAM: m },
  },
  {
    // imports the POS's end-of-day file at the outlet's stores; reads no sales, costs or
    // reports (ADR 039)
    code: 'CASHIER',
    name: 'Cashier',
    kind: 'role',
    grants: { POS_IMPORT: m },
  },
  {
    // plans events (with their item and staff needs) for the whole outlet (ADR 016)
    code: 'EVENT_PLANNER',
    name: 'Event Planner',
    kind: 'role',
    grants: { EVENTS: m },
  },
  {
    // receives goods against an existing PO (inv.receive: PO view + adjustments modify)
    code: 'STOCK_USER',
    name: 'Stock User',
    kind: 'role',
    grants: {
      STOCK_LEVELS: v,
      STOCK_ADJUSTMENTS: m,
      TRANSFERS: m,
      PURCHASE_ORDERS: v,
      RECIPES: v,
      PRODUCTION: m,
    },
  },
  {
    code: 'STORE_KEEPER',
    name: 'Store Keeper',
    kind: 'role',
    grants: {
      STOCK_LEVELS: v,
      STOCK_ADJUSTMENTS: m,
      STOCK_CHECK: v,
      TRANSFERS: m,
      PURCHASE_ORDERS: m,
      BILLS: m,
      AI_RECOMMENDATIONS: v,
      RECIPES: v,
      PRODUCTION: m,
    },
  },
  {
    code: 'COST_CONTROLLER',
    name: 'Cost Controller',
    kind: 'role',
    grants: {
      STOCK_LEVELS: v,
      STOCK_ADJUSTMENTS: v,
      STOCK_CHECK: m,
      PURCHASE_ORDERS: v,
      BILLS: v,
      TRANSFERS: v,
      RECIPES: v,
      MENU: v,
      PRODUCTION: v,
      SALES: m,
    },
  },
  {
    // verifies stock where the company has no Cost Controller (INV-11, ADR 043); given by
    // the Account Owner
    code: 'STOCK_VERIFIER',
    name: 'Stock Verifier',
    kind: 'role',
    grants: { STOCK_LEVELS: v, STOCK_CHECK: m },
  },
  {
    code: 'OUTLET_HR',
    name: 'Outlet HR',
    kind: 'role',
    grants: { WORKERS: m, LEAVE: m, ROSTER: v, ATTENDANCE: v, ATTENDANCE_SELFIES: v },
  },
  {
    code: 'OUTLET_MANAGER',
    name: 'Outlet Manager',
    kind: 'role',
    grants: {
      STOCK_LEVELS: v,
      STOCK_ADJUSTMENTS: m,
      STOCK_CHECK: v,
      PURCHASE_ORDERS: m,
      BILLS: m,
      TRANSFERS: m,
      // worker records: People, and asking for a deactivation where there is no HR
      // executive (UX-5, ADR 035)
      WORKERS: m,
      ROSTER: m,
      ATTENDANCE: m,
      LEAVE: v,
      EVENTS: m,
      AI_RECOMMENDATIONS: m,
      SHIFT_SWAPS: v,
      RECIPES: v,
      MENU: m,
      DERIVED_MENU: v,
      PRODUCTION: m,
      SALES: m,
      DERIVED_PRODUCTION: v,
      DERIVED_SALES: v,
      TASKS: m,
      CHECKLIST_TEMPLATES: m,
      MAINTENANCE: m,
      LABOUR_COST: v,
    },
  },
  {
    code: 'AREA_MANAGER',
    name: 'Area Manager',
    kind: 'role',
    grants: {
      WORKERS: v,
      ROSTER: v,
      ATTENDANCE: v,
      LEAVE: v,
      EVENTS: v,
      AI_RECOMMENDATIONS: v,
      SHIFT_SWAPS: v,
      DERIVED_STOCK_LEVELS: v,
      DERIVED_STOCK_ADJUSTMENTS: v,
      DERIVED_PURCHASE_ORDERS: v,
      DERIVED_TRANSFERS: v,
      DERIVED_MENU: v,
      DERIVED_PRODUCTION: v,
      DERIVED_SALES: v,
      TASKS: v,
      CHECKLIST_TEMPLATES: v,
      MAINTENANCE: v,
      LABOUR_COST: v,
    },
  },
  {
    code: 'HUB_MANAGER',
    name: 'Hub Manager',
    kind: 'role',
    grants: {
      STOCK_LEVELS: v,
      STOCK_ADJUSTMENTS: m,
      STOCK_CHECK: v,
      PURCHASE_ORDERS: v,
      BILLS: v,
      TRANSFERS: m,
      RECIPES: v,
      MENU: v,
      PRODUCTION: m,
    },
  },
  { code: 'SUPPLY_VIEWER', name: 'Supply Viewer', kind: 'role', grants: { STOCK_LEVELS: v } },
  {
    code: 'HR_ADMIN',
    name: 'HR Admin',
    kind: 'role',
    grants: {
      WORKERS: m,
      COMPENSATION: m,
      LEAVE: m,
      ROSTER: v,
      ATTENDANCE: v,
      ATTENDANCE_SELFIES: v,
      WF_CONFIG: v,
      LABOUR_COST: v,
    },
  },
  {
    code: 'SECURITY_ADMIN',
    name: 'Security Admin',
    kind: 'role',
    grants: { AUDIT: v, SECURITY_ROLES: v, WF_CONFIG: v },
  },
  { code: 'AUDITOR', name: 'Auditor', kind: 'role', grants: { AUDIT: v, SECURITY_ROLES: v } },
  { code: 'USER_ADMIN', name: 'User Admin', kind: 'admin', grants: { USER_ACCESS: m } },
  {
    code: 'ACCOUNT_OWNER',
    name: 'Account Owner',
    kind: 'admin',
    grants: {
      USER_ACCESS: m,
      COMPANY_SETTINGS: m,
      SECURITY_ROLES: v,
      WF_CONFIG: v,
      REPORTS: v,
    },
  },
  {
    // service user for AI recommendations: view only, except its own recommendations
    code: 'AI_AGENT',
    name: 'AI Agent',
    kind: 'role',
    grants: {
      STOCK_LEVELS: v,
      PURCHASE_ORDERS: v,
      TRANSFERS: v,
      WORKERS: v,
      ROSTER: v,
      ATTENDANCE: v,
      LEAVE: v,
      EVENTS: v,
      AI_RECOMMENDATIONS: m,
      SHIFT_SWAPS: v,
      RECIPES: v,
      MENU: v,
      PRODUCTION: v,
      SALES: v,
      TASKS: v,
      CHECKLIST_TEMPLATES: v,
      MAINTENANCE: v,
    },
  },
];

/** Groups no longer offered; the migration moves their assignments (ADR 009). */
export const RETIRED_GROUPS: Readonly<Record<string, string>> = { CHEF: 'STOCK_USER' };

export function groupDef(code: string): GroupDef | undefined {
  return ACCESS_GROUPS.find((g) => g.code === code);
}
