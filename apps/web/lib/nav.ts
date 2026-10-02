// Bottom navigation: at most five items, chosen by the kind of work a person does (their
// access groups, core.my_access()), then filtered by what they can open (core.my_domains()
// and what there is to open: Menu and Production, audit ADR 016). Everything else they can
// open is linked from Home. This is presentation only: RLS and the RPCs enforce access
// (ADR 004).

export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

export interface NavFeatures {
  /** a recipe they may read, or menu costs somewhere */
  menu: boolean;
  /** a store where they record production */
  production: boolean;
}

export interface NavInput extends NavFeatures {
  /** access group codes from core.my_access(), SELF included */
  groups: ReadonlySet<string>;
  /** domains from core.my_domains() */
  domains: ReadonlySet<string>;
}

export const MAX_NAV_ITEMS = 5;

export type NavKey =
  'home' | 'inbox' | 'tasks' | 'production' | 'stock' | 'menu' | 'roster' | 'requests' | 'admin';

export const NAV_ITEMS: Readonly<Record<NavKey, NavItem>> = {
  home: { href: '/', label: 'Home', icon: '⌂' },
  inbox: { href: '/inbox', label: 'Inbox', icon: '✓' },
  tasks: { href: '/tasks', label: 'Tasks', icon: '☑' },
  production: { href: '/stock/production', label: 'Production', icon: '▦' },
  stock: { href: '/stock', label: 'Stock', icon: '▦' },
  // menu costs for MENU holders, otherwise the recipes and procedures they may read
  menu: { href: '/menu', label: 'Menu', icon: '☰' },
  roster: { href: '/roster', label: 'Roster', icon: '◷' },
  requests: { href: '/requests', label: 'Requests', icon: '≡' },
  // user administration (ADR 011) as well as the security roles view
  admin: { href: '/admin', label: 'Admin', icon: '⚙' },
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
 * Candidates in order per profile. Alternatives in a slot (an array) take the first one the
 * person can open; a slot with none is skipped.
 */
const PROFILES: Readonly<Record<NavProfile, readonly (NavKey | readonly NavKey[])[]>> = {
  outlet: ['home', 'inbox', 'stock', 'roster', 'tasks'],
  department: ['home', 'inbox', 'tasks', 'roster', ['stock', 'requests']],
  store: ['home', 'inbox', 'stock', 'tasks', 'roster'],
  cost: ['home', 'inbox', 'stock', 'menu', 'requests'],
  frontline: ['home', 'tasks', ['stock', 'production', 'admin'], 'roster', 'inbox'],
  // HR, administrators, auditors: no tasks of their own on the floor
  office: ['home', 'inbox', ['admin', 'roster'], 'requests'],
};

export function visibleNav(i: NavInput): NavItem[] {
  const keys: NavKey[] = [];
  for (const slot of PROFILES[navProfile(i.groups)]) {
    const options = typeof slot === 'string' ? [slot] : slot;
    const pick = options.find((k) => canOpen(k, i) && !keys.includes(k));
    if (pick) keys.push(pick);
  }
  return keys.slice(0, MAX_NAV_ITEMS).map((k) => NAV_ITEMS[k]);
}

/** Items the person can open that are not in their bottom nav: Home links to these. */
export function moreItems(i: NavInput): NavItem[] {
  const inNav = new Set(visibleNav(i).map((n) => n.href));
  return (
    (Object.keys(NAV_ITEMS) as NavKey[])
      // Home has its own Stock and Production shortcuts
      .filter((k) => !['home', 'stock', 'production'].includes(k))
      .filter((k) => canOpen(k, i) && !inNav.has(NAV_ITEMS[k].href))
      .map((k) => NAV_ITEMS[k])
  );
}
