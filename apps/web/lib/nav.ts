// Bottom navigation: at most five items, chosen by the kind of work a person does (their
// access groups, core.my_access()), then filtered by what they can open (core.my_domains()
// and what there is to open: Menu and Production, audit ADR 016). Frontline staff get three
// (Home, Tasks, Me; UX-6, ADR 034); everything else a person can open is on Me. This is
// presentation only: RLS and the RPCs enforce access (ADR 004).

import type { IconName } from '@/components/icon';

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

export interface NavFeatures {
  /** a recipe they may read, or menu costs somewhere */
  menu: boolean;
  /** a store where they record production */
  production: boolean;
  /** business reports (an outlet or department), only their own week, or none (ADR 023) */
  reports: 'business' | 'mine' | 'none';
}

export interface NavInput extends NavFeatures {
  /** access group codes from core.my_access(), SELF included */
  groups: ReadonlySet<string>;
  /** domains from core.my_domains() */
  domains: ReadonlySet<string>;
}

export const MAX_NAV_ITEMS = 5;

export type NavKey =
  | 'home'
  | 'inbox'
  | 'tasks'
  | 'production'
  | 'stock'
  | 'menu'
  | 'roster'
  | 'requests'
  | 'admin'
  | 'reports'
  | 'me';

export const NAV_ITEMS: Readonly<Record<NavKey, NavItem>> = {
  home: { href: '/', label: 'Home', icon: 'home' },
  // approvals and other requests waiting for the person (wf.my_inbox)
  inbox: { href: '/inbox', label: 'Approvals', icon: 'inbox' },
  tasks: { href: '/tasks', label: 'Tasks', icon: 'tasks' },
  // plain words (UX-6): "Make", not "Production"
  production: { href: '/stock/production', label: 'Make', icon: 'pot' },
  stock: { href: '/stock', label: 'Stock', icon: 'box' },
  // menu costs for MENU holders, otherwise the recipes and procedures they may read
  menu: { href: '/menu', label: 'Menu', icon: 'book' },
  roster: { href: '/roster', label: 'Roster', icon: 'calendar' },
  requests: { href: '/requests', label: 'Requests', icon: 'list' },
  // user administration (ADR 011) as well as the security roles view
  admin: { href: '/admin', label: 'Admin', icon: 'gear' },
  // reports (ADR 023): business reports only; "My week" is on Me
  reports: { href: '/reports', label: 'Reports', icon: 'chart' },
  // the person's own things and every other screen they can open (UX-6)
  me: { href: '/me', label: 'Me', icon: 'user' },
};

/** Whether the person can open each item at all (the nav or Home). */
export function canOpen(key: NavKey, i: NavInput): boolean {
  switch (key) {
    case 'stock':
      return i.domains.has('STOCK_LEVELS');
    // with stock access, Production is one of the Stock tabs
    case 'production':
      return i.production;
    case 'menu':
      return i.menu;
    case 'roster':
      return i.domains.has('ROSTER');
    case 'tasks':
      return i.domains.has('TASKS');
    case 'admin':
      return i.domains.has('USER_ACCESS') || i.domains.has('SECURITY_ROLES');
    case 'reports':
      return i.reports !== 'none';
    default:
      return true;
  }
}

/** Frontline groups: no approvals, no one else's work to manage. */
const FRONTLINE = new Set(['SELF', 'STAFF', 'PRODUCTION_TEAM', 'STOCK_USER', 'EVENT_PLANNER']);

export type NavProfile = 'outlet' | 'department' | 'store' | 'cost' | 'frontline' | 'office';

export function navProfile(groups: ReadonlySet<string>): NavProfile {
  const any = (...g: string[]) => g.some((x) => groups.has(x));
  if (any('OUTLET_MANAGER', 'AREA_MANAGER', 'HUB_MANAGER')) return 'outlet';
  if (any('DEPARTMENT_HEAD', 'SUPERVISOR')) return 'department';
  if (any('STORE_KEEPER')) return 'store';
  if (any('COST_CONTROLLER')) return 'cost';
  // a user administrator who is otherwise frontline keeps the frontline nav
  if ([...groups].every((g) => FRONTLINE.has(g) || g === 'USER_ADMIN')) return 'frontline';
  return 'office';
}

/**
 * Candidates in order per profile (the UX-6 mock-ups). Alternatives in a slot (an array)
 * take the first one the person can open; a slot with none is skipped. Me is always last.
 */
const PROFILES: Readonly<Record<NavProfile, readonly (NavKey | readonly NavKey[])[]>> = {
  // GM, area and hub managers: their day on Home, then what waits for their yes
  outlet: ['home', 'inbox', ['reports', 'stock'], 'me'],
  // department heads: approvals sit on Home; Roster and their stock or tasks are tabs
  department: ['home', 'roster', ['stock', 'tasks'], 'reports', 'me'],
  store: ['home', 'stock', 'tasks', 'me'],
  cost: ['home', 'stock', 'reports', 'inbox', 'me'],
  // four tiles on Home do the rest (UX-6)
  frontline: ['home', 'tasks', 'me'],
  // HR, administrators, auditors: no tasks of their own on the floor
  // the Account Owner reads every report (REPORTS); HR the departments' attendance
  office: ['home', 'inbox', 'reports', ['admin', 'roster'], 'me'],
};

export function visibleNav(i: NavInput): NavItem[] {
  const keys: NavKey[] = [];
  for (const slot of PROFILES[navProfile(i.groups)]) {
    const options = typeof slot === 'string' ? [slot] : slot;
    // a report slot only for business reports: "My week" opens from Home
    const pick = options.find(
      (k) => canOpen(k, i) && !keys.includes(k) && (k !== 'reports' || i.reports === 'business'),
    );
    if (pick) keys.push(pick);
  }
  return keys.slice(0, MAX_NAV_ITEMS).map((k) => NAV_ITEMS[k]);
}

/** Whether Approvals is a tab; if not, the header carries it (UX-6). */
export function approvalsInNav(i: NavInput): boolean {
  return visibleNav(i).some((n) => n.href === NAV_ITEMS.inbox.href);
}
