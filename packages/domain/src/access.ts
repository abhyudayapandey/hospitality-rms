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
  { code: 'PURCHASE_ORDERS', tree: 'delivery' },
  { code: 'TRANSFERS', tree: 'delivery' },
  // recipes and prep procedures where they are made or sold (no costs, ADR 014)
  { code: 'RECIPES', tree: 'delivery' },
  // the same through a department's linked store (kitchen staff -> kitchen store)
  { code: 'RECIPES_TEAM', tree: 'org' },
  // prices and costs; modify edits menus, prices and recipes
  { code: 'MENU', tree: 'delivery' },
  { code: 'WORKERS', tree: 'org' },
  { code: 'COMPENSATION', tree: 'org' },
  { code: 'ROSTER', tree: 'org' },
  { code: 'ATTENDANCE', tree: 'org' },
  { code: 'LEAVE', tree: 'org' },
  { code: 'EVENTS', tree: 'org' },
  { code: 'SHIFT_SWAPS', tree: 'org' },
  { code: 'AI_RECOMMENDATIONS', tree: 'org' },
  { code: 'DERIVED_STOCK_LEVELS', tree: 'org' },
  { code: 'DERIVED_STOCK_ADJUSTMENTS', tree: 'org' },
  { code: 'DERIVED_PURCHASE_ORDERS', tree: 'org' },
  { code: 'DERIVED_TRANSFERS', tree: 'org' },
  { code: 'DERIVED_MENU', tree: 'org' },
  { code: 'AUDIT', tree: 'org' },
  { code: 'NOTIFICATIONS', tree: 'self' },
  { code: 'USER_ACCESS', tree: 'org', admin: true },
  { code: 'COMPANY_SETTINGS', tree: 'org', admin: true },
  { code: 'SECURITY_ROLES', tree: 'org', admin: true },
  { code: 'WF_CONFIG', tree: 'org', admin: true },
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
      NOTIFICATIONS: v,
    },
  },
  {
    code: 'STAFF',
    name: 'Staff',
    kind: 'role',
    grants: { ROSTER: v, EVENTS: v, RECIPES_TEAM: v },
  },
  {
    code: 'SUPERVISOR',
    name: 'Supervisor',
    kind: 'role',
    grants: { ROSTER: v, ATTENDANCE: v, EVENTS: v, RECIPES_TEAM: v },
  },
  {
    code: 'DEPARTMENT_HEAD',
    name: 'Department Head',
    kind: 'role',
    grants: {
      ROSTER: m,
      ATTENDANCE: m,
      LEAVE: v,
      SHIFT_SWAPS: v,
      WORKERS: v,
      EVENTS: m,
      AI_RECOMMENDATIONS: v,
      RECIPES_TEAM: v,
      DERIVED_MENU: v,
    },
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
    },
  },
  {
    code: 'STORE_KEEPER',
    name: 'Store Keeper',
    kind: 'role',
    grants: {
      STOCK_LEVELS: v,
      STOCK_ADJUSTMENTS: m,
      TRANSFERS: m,
      PURCHASE_ORDERS: m,
      AI_RECOMMENDATIONS: v,
      RECIPES: v,
    },
  },
  {
    code: 'COST_CONTROLLER',
    name: 'Cost Controller',
    kind: 'role',
    grants: {
      STOCK_LEVELS: v,
      STOCK_ADJUSTMENTS: v,
      PURCHASE_ORDERS: v,
      TRANSFERS: v,
      RECIPES: v,
      MENU: v,
    },
  },
  {
    code: 'OUTLET_HR',
    name: 'Outlet HR',
    kind: 'role',
    grants: { WORKERS: m, LEAVE: m, ROSTER: v, ATTENDANCE: v },
  },
  {
    code: 'OUTLET_MANAGER',
    name: 'Outlet Manager',
    kind: 'role',
    grants: {
      STOCK_LEVELS: v,
      STOCK_ADJUSTMENTS: m,
      PURCHASE_ORDERS: m,
      TRANSFERS: m,
      WORKERS: v,
      ROSTER: m,
      ATTENDANCE: m,
      LEAVE: v,
      EVENTS: m,
      AI_RECOMMENDATIONS: m,
      SHIFT_SWAPS: v,
      RECIPES: v,
      MENU: m,
      DERIVED_MENU: v,
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
    },
  },
  {
    code: 'HUB_MANAGER',
    name: 'Hub Manager',
    kind: 'role',
    grants: {
      STOCK_LEVELS: v,
      STOCK_ADJUSTMENTS: m,
      PURCHASE_ORDERS: v,
      TRANSFERS: m,
      RECIPES: v,
      MENU: v,
    },
  },
  { code: 'SUPPLY_VIEWER', name: 'Supply Viewer', kind: 'role', grants: { STOCK_LEVELS: v } },
  {
    code: 'HR_ADMIN',
    name: 'HR Admin',
    kind: 'role',
    grants: { WORKERS: m, COMPENSATION: m, LEAVE: m, ROSTER: v, ATTENDANCE: v, WF_CONFIG: v },
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
    grants: { USER_ACCESS: m, COMPANY_SETTINGS: m, SECURITY_ROLES: v, WF_CONFIG: v },
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
    },
  },
];

/** Groups no longer offered; the migration moves their assignments (ADR 009). */
export const RETIRED_GROUPS: Readonly<Record<string, string>> = { CHEF: 'STOCK_USER' };

export function groupDef(code: string): GroupDef | undefined {
  return ACCESS_GROUPS.find((g) => g.code === code);
}
