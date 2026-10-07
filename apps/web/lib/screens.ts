// Every screen a person can open, with its icon (UX-6, ADR 034). The Me page lists them,
// and frontline Homes show four of them as tiles. Pure, so it can be unit tested; what a
// person may open still comes from their domain access (rule 2), never from a check here,
// and the pages and the database refuse anything else.

import type { IconName } from '@/components/icon';
import { canOpen, type NavInput } from './nav';

export interface ScreenInput extends NavInput {
  /** core.my_domains() with each domain's access, switched-off modules left out */
  access: ReadonlyMap<string, 'view' | 'modify'>;
  /** works at an outlet: has shifts, a clock and swaps of their own (audit #13) */
  atWork: boolean;
}

export type ScreenSection = 'mine' | 'work' | 'team';

export type ScreenKey =
  | 'shifts'
  | 'clock'
  | 'leave'
  | 'swaps'
  | 'myWeek'
  | 'requests'
  | 'inbox'
  | 'notifications'
  | 'profile'
  | 'tasks'
  | 'problem'
  | 'make'
  | 'menu'
  | 'stock'
  | 'count'
  | 'check'
  | 'wastage'
  | 'orders'
  | 'transfers'
  | 'bills'
  | 'compliance'
  | 'sales'
  | 'posImport'
  | 'roster'
  | 'events'
  | 'reports'
  | 'admin';

export interface Screen {
  key: ScreenKey;
  href: string;
  label: string;
  icon: IconName;
  section: ScreenSection;
}

export const SECTION_TITLES: Readonly<Record<ScreenSection, string>> = {
  mine: 'Mine',
  work: 'Work',
  team: 'Team and business',
};

const can = (i: ScreenInput, domain: string, access: 'view' | 'modify' = 'view') =>
  i.access.has(domain) && (access === 'view' || i.access.get(domain) === 'modify');

const SCREENS: readonly (Screen & { show: (i: ScreenInput) => boolean })[] = [
  {
    key: 'shifts',
    href: '/roster/my',
    label: 'My shifts',
    icon: 'calendar',
    section: 'mine',
    show: (i) => i.atWork && can(i, 'ROSTER'),
  },
  {
    key: 'clock',
    href: '/roster/clock',
    label: 'Clock',
    icon: 'clock',
    section: 'mine',
    show: (i) => i.atWork && can(i, 'ATTENDANCE', 'modify'),
  },
  {
    key: 'leave',
    href: '/leave',
    label: 'Leave',
    icon: 'sun',
    section: 'mine',
    show: (i) => can(i, 'LEAVE'),
  },
  {
    key: 'swaps',
    href: '/roster/swaps',
    label: 'Swaps',
    icon: 'swap',
    section: 'mine',
    show: (i) => i.atWork && can(i, 'SHIFT_SWAPS'),
  },
  {
    key: 'myWeek',
    href: '/reports/my-week',
    label: 'My week',
    icon: 'chart',
    section: 'mine',
    show: (i) => i.reports === 'mine',
  },
  {
    key: 'requests',
    href: '/requests',
    label: 'Things I asked for',
    icon: 'list',
    section: 'mine',
    show: () => true,
  },
  {
    key: 'inbox',
    href: '/inbox',
    label: 'To do list',
    icon: 'inbox',
    section: 'mine',
    show: () => true,
  },
  {
    key: 'notifications',
    href: '/notifications',
    label: 'Notifications',
    icon: 'bell',
    section: 'mine',
    show: () => true,
  },
  {
    key: 'profile',
    href: '/profile',
    label: 'Profile',
    icon: 'user',
    section: 'mine',
    show: () => true,
  },
  {
    key: 'tasks',
    href: '/tasks',
    label: 'My tasks',
    icon: 'tasks',
    section: 'work',
    show: (i) => canOpen('tasks', i),
  },
  {
    key: 'make',
    href: '/stock/production',
    label: 'Make',
    icon: 'pot',
    section: 'work',
    show: (i) => canOpen('production', i),
  },
  {
    key: 'menu',
    href: '/menu',
    // without menu costs, the Menu screen is the recipes (UX U-4)
    label: 'Menu',
    icon: 'book',
    section: 'work',
    show: (i) => canOpen('menu', i),
  },
  {
    key: 'stock',
    href: '/stock',
    label: 'Stock',
    icon: 'box',
    section: 'work',
    show: (i) => canOpen('stock', i),
  },
  {
    key: 'count',
    href: '/stock/count',
    label: 'Count',
    icon: 'clipboard',
    section: 'work',
    show: (i) => can(i, 'STOCK_ADJUSTMENTS', 'modify'),
  },
  {
    key: 'check',
    href: '/stock/check',
    label: 'Stock check',
    icon: 'clipboard',
    section: 'work',
    show: (i) => can(i, 'STOCK_CHECK'),
  },
  {
    key: 'wastage',
    href: '/stock/wastage',
    label: 'Wastage',
    icon: 'trash',
    section: 'work',
    show: (i) => can(i, 'STOCK_ADJUSTMENTS', 'modify'),
  },
  {
    key: 'orders',
    href: '/stock/orders',
    label: 'Orders',
    icon: 'cart',
    section: 'work',
    show: (i) => can(i, 'PURCHASE_ORDERS'),
  },
  {
    key: 'transfers',
    href: '/stock/transfers',
    label: 'Transfers',
    icon: 'truck',
    section: 'work',
    show: (i) => can(i, 'TRANSFERS'),
  },
  {
    // vendor bills (BIL-1 to BIL-3, ADR 050)
    key: 'bills',
    href: '/stock/bills',
    label: 'Bills',
    icon: 'bill',
    section: 'work',
    show: (i) => can(i, 'BILLS'),
  },
  {
    key: 'sales',
    href: '/menu/sales',
    label: 'Sales',
    icon: 'sales',
    section: 'work',
    show: (i) => can(i, 'SALES') || can(i, 'DERIVED_SALES'),
  },
  {
    // the cashier's end-of-day job (SAL-2, ADR 039); managers reach it from Sales too
    key: 'posImport',
    href: '/menu/sales/import',
    label: 'Import sales',
    icon: 'upload',
    section: 'work',
    show: (i) => can(i, 'POS_IMPORT', 'modify'),
  },
  {
    key: 'problem',
    href: '/tasks/maintenance/new',
    label: 'Report a problem',
    icon: 'wrench',
    section: 'work',
    show: (i) => can(i, 'MAINTENANCE'),
  },
  {
    // licences and the compliance calendar (ADR 069), where Compliance is in the plan;
    // first in Team: what can close the outlet comes before everything else
    key: 'compliance',
    href: '/compliance',
    label: 'Compliance',
    icon: 'shield',
    section: 'team',
    show: (i) => can(i, 'COMPLIANCE'),
  },
  {
    // the Team side of Roster: roster builders, and people above outlet level
    key: 'roster',
    href: '/roster',
    label: 'Roster',
    icon: 'calendar',
    section: 'team',
    show: (i) => can(i, 'ROSTER', 'modify') || (!i.atWork && can(i, 'ROSTER')),
  },
  {
    key: 'events',
    href: '/events',
    label: 'Events',
    icon: 'star',
    section: 'team',
    show: (i) => can(i, 'EVENTS'),
  },
  {
    key: 'reports',
    href: '/reports',
    label: 'Reports',
    icon: 'chart',
    section: 'team',
    show: (i) => i.reports === 'business',
  },
  {
    key: 'admin',
    href: '/admin',
    label: 'Admin',
    icon: 'gear',
    section: 'team',
    show: (i) => canOpen('admin', i),
  },
];

/** The screens the person can open, in the order the Me page lists them. */
export function screensFor(i: ScreenInput): Screen[] {
  return SCREENS.filter((s) => s.show(i)).map(({ show: _, ...s }) => ({
    ...s,
    label: s.key === 'menu' && !i.access.has('MENU') ? 'Recipes' : s.label,
  }));
}

/**
 * Frontline Home's four tiles (UX-6): the cashier's import first (SAL-2), their tasks, what
 * they make, the store they keep, their shifts and leave, then reporting a problem. Clocking in is the card above them.
 */
const TILE_ORDER: readonly ScreenKey[] = [
  'posImport',
  'tasks',
  'make',
  'stock',
  'shifts',
  'leave',
  'problem',
  'menu',
  'swaps',
];

export function homeTiles(i: ScreenInput, max = 4): Screen[] {
  const by = new Map(screensFor(i).map((s) => [s.key, s]));
  return TILE_ORDER.flatMap((k) => by.get(k) ?? []).slice(0, max);
}
