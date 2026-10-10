// Every screen a person can open, with its icon (UX-6, ADR 034). The Me page lists them,
// and frontline Homes show four of them as tiles. Pure, so it can be unit tested; what a
// person may open still comes from their domain access (rule 2), never from a check here,
// and the pages and the database refuse anything else.

import { ACCESS_GROUPS, DUTY_BY_CODE, type Access } from '@outlet-ops/domain';
import type { IconName } from '@/components/icon';
import { canOpen, type NavInput } from './nav';

export interface ScreenInput extends NavInput {
  /** core.my_domains() with each domain's access, switched-off modules left out */
  access: ReadonlyMap<string, 'view' | 'modify'>;
  /** works at an outlet: has shifts, a clock and swaps of their own (audit #13) */
  atWork: boolean;
  /** the company keeps swaps for those who change the roster (SW-4, ADR 035, 074) */
  swapsManagersOnly?: boolean;
  /** keeps or reads a hotel's breakfast (Shell.breakfast, ADR 097) */
  breakfast?: boolean;
}

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
  | 'opened'
  | 'compliance'
  | 'sales'
  | 'posImport'
  | 'briefing'
  | 'minibar'
  | 'rooms'
  | 'logbook'
  | 'registers'
  | 'utilities'
  | 'breakage'
  | 'breakfast'
  | 'audits'
  | 'sops'
  | 'training'
  | 'excise'
  | 'linen'
  | 'roster'
  | 'events'
  | 'reports'
  | 'admin';

export interface Screen {
  key: ScreenKey;
  href: string;
  label: string;
  icon: IconName;
}

const can = (i: ScreenInput, domain: string, access: 'view' | 'modify' = 'view') =>
  i.access.has(domain) && (access === 'view' || i.access.get(domain) === 'modify');

const SCREENS: readonly (Screen & { show: (i: ScreenInput) => boolean })[] = [
  {
    key: 'shifts',
    href: '/roster/my',
    label: 'My shifts',
    icon: 'calendar',
    show: (i) => i.atWork && can(i, 'ROSTER'),
  },
  {
    key: 'clock',
    href: '/roster/clock',
    label: 'Clock',
    icon: 'clock',
    show: (i) => i.atWork && can(i, 'ATTENDANCE', 'modify'),
  },
  {
    key: 'leave',
    href: '/leave',
    label: 'Leave',
    icon: 'umbrella',
    show: (i) => can(i, 'LEAVE'),
  },
  {
    key: 'swaps',
    href: '/roster/swaps',
    label: 'Swaps',
    icon: 'swap',
    // with swaps for management only, staff never see Swaps (the database refuses them too)
    show: (i) =>
      i.atWork && can(i, 'SHIFT_SWAPS') && (!i.swapsManagersOnly || can(i, 'ROSTER', 'modify')),
  },
  {
    key: 'myWeek',
    href: '/reports/my-week',
    label: 'My week',
    icon: 'chart',
    show: (i) => i.reports === 'mine',
  },
  {
    key: 'requests',
    href: '/requests',
    label: 'Things I asked for',
    icon: 'hand',
    show: () => true,
  },
  {
    key: 'inbox',
    href: '/inbox',
    label: 'To do list',
    icon: 'inbox',
    show: () => true,
  },
  {
    key: 'notifications',
    href: '/notifications',
    label: 'Notifications',
    icon: 'bell',
    show: () => true,
  },
  {
    key: 'profile',
    href: '/profile',
    label: 'Profile',
    icon: 'user',
    show: () => true,
  },
  {
    key: 'tasks',
    href: '/tasks',
    label: 'My tasks',
    icon: 'tasks',
    show: (i) => canOpen('tasks', i),
  },
  {
    key: 'make',
    href: '/stock/production',
    label: 'Make',
    icon: 'pot',
    show: (i) => canOpen('production', i),
  },
  {
    key: 'menu',
    href: '/menu',
    // without menu costs, the Menu screen is the recipes (UX U-4)
    label: 'Menu',
    icon: 'chefHat',
    show: (i) => canOpen('menu', i),
  },
  {
    key: 'stock',
    href: '/stock',
    label: 'Stock',
    icon: 'box',
    show: (i) => canOpen('stock', i),
  },
  {
    key: 'count',
    href: '/stock/count',
    label: 'Count',
    icon: 'clipboard',
    show: (i) => can(i, 'STOCK_ADJUSTMENTS', 'modify'),
  },
  {
    key: 'check',
    href: '/stock/check',
    label: 'Stock check',
    icon: 'clipboardCheck',
    show: (i) => can(i, 'STOCK_CHECK'),
  },
  {
    key: 'wastage',
    href: '/stock/wastage',
    label: 'Wastage',
    icon: 'trash',
    show: (i) => can(i, 'STOCK_ADJUSTMENTS', 'modify'),
  },
  {
    key: 'orders',
    href: '/stock/orders',
    label: 'Orders',
    icon: 'cart',
    show: (i) => can(i, 'PURCHASE_ORDERS'),
  },
  {
    key: 'transfers',
    href: '/stock/transfers',
    label: 'Transfers',
    icon: 'truck',
    show: (i) => can(i, 'TRANSFERS'),
  },
  {
    // vendor bills (BIL-1 to BIL-3, ADR 050)
    key: 'bills',
    href: '/stock/bills',
    label: 'Bills',
    icon: 'bill',
    show: (i) => can(i, 'BILLS'),
  },
  {
    // opened packs for someone who opens them but has no Stock screen (a commis, ADR 097);
    // with stock access it is the Stock screen's Opened tab
    key: 'opened',
    href: '/stock/opened',
    label: 'Opened packs',
    icon: 'openBottle',
    show: (i) => can(i, 'SHELF_LIFE', 'modify') && !canOpen('stock', i),
  },
  {
    key: 'sales',
    href: '/menu/sales',
    label: 'Sales',
    icon: 'rupee',
    show: (i) => can(i, 'SALES') || can(i, 'DERIVED_SALES'),
  },
  {
    // the cashier's end-of-day job (SAL-2, ADR 039); managers reach it from Sales too
    key: 'posImport',
    href: '/menu/sales/import',
    label: 'Import sales',
    icon: 'upload',
    show: (i) => can(i, 'POS_IMPORT', 'modify'),
  },
  {
    // today's note for the shift (ADR 070): its writers; everyone reads it on Home
    key: 'briefing',
    href: '/briefing',
    label: "Today's briefing",
    icon: 'megaphone',
    show: (i) => can(i, 'BRIEFING', 'modify'),
  },
  {
    // the rooms' minibars (ADR 072): housekeeping and front office check and charge them
    key: 'minibar',
    href: '/minibar',
    label: 'Minibars',
    icon: 'fridge',
    show: (i) => can(i, 'MINIBAR'),
  },
  {
    // each room's status (ADR 088): front office and housekeeping
    key: 'rooms',
    href: '/rooms',
    label: 'Rooms',
    icon: 'bed',
    show: (i) => can(i, 'ROOMS'),
  },
  {
    // handovers to the next shift and logs (ADR 089): wherever people keep a logbook
    key: 'logbook',
    href: '/logbook',
    label: 'Logbook',
    icon: 'notebook',
    show: (i) => can(i, 'LOGBOOK'),
  },
  {
    // lost and found, incidents, visitors, keys... (ADR 090): who keeps each is checked there
    key: 'registers',
    href: '/registers',
    label: 'Registers',
    icon: 'register',
    show: (i) => can(i, 'REGISTERS'),
  },
  {
    // meters and what they used (ADR 091): engineering and the managers
    key: 'utilities',
    href: '/utilities',
    label: 'Utilities',
    icon: 'bulb',
    show: (i) => can(i, 'UTILITIES'),
  },
  {
    // what broke and what it cost (ADR 093): every department records; heads see the outlet's
    key: 'breakage',
    href: '/breakage',
    label: 'Breakage',
    icon: 'brokenGlass',
    show: (i) => can(i, 'BREAKAGE'),
  },
  {
    // the day's breakfast guests by mode (ADR 094): front office and housekeeping keep it, the
    // kitchen and restaurant of a hotel with rooms read it; nobody else gets the tile (ADR 097)
    key: 'breakfast',
    href: '/breakfast',
    label: 'Breakfast',
    icon: 'plate',
    show: (i) => i.breakfast === true,
  },
  {
    // the SOPs for my place and job role, with "I've read this" (ADR 095)
    key: 'sops',
    href: '/me/sops',
    label: 'My SOPs',
    icon: 'book',
    show: (i) => can(i, 'TRAINING'),
  },
  {
    // training sessions, attendance and test scores; who has read the SOPs (ADR 095)
    key: 'training',
    href: '/training',
    label: 'Training',
    icon: 'mortarboard',
    show: (i) => can(i, 'TRAINING', 'modify'),
  },
  {
    // the daily bar register, the FLR and transport permits (ADR 096)
    key: 'excise',
    href: '/excise',
    label: 'Excise',
    icon: 'bottle',
    show: (i) => can(i, 'EXCISE'),
  },
  {
    // service audits and taste panels, their scores and trend (ADR 095)
    key: 'audits',
    href: '/audits',
    label: 'Audits',
    icon: 'medal',
    show: (i) => can(i, 'AUDITS'),
  },
  {
    // the laundry exchange and uniforms (ADR 094)
    key: 'linen',
    href: '/linen',
    label: 'Linen & uniforms',
    icon: 'towel',
    show: (i) => can(i, 'LINEN', 'modify'),
  },
  {
    key: 'problem',
    href: '/tasks/maintenance/new',
    label: 'Report a problem',
    icon: 'wrench',
    show: (i) => can(i, 'MAINTENANCE'),
  },
  {
    // licences and the compliance calendar (ADR 069), where Compliance is in the plan;
    // first in Team: what can close the outlet comes before everything else
    key: 'compliance',
    href: '/compliance',
    label: 'Compliance',
    icon: 'shield',
    show: (i) => can(i, 'COMPLIANCE'),
  },
  {
    // the Team side of Roster: roster builders, and people above outlet level
    key: 'roster',
    href: '/roster',
    label: 'Roster',
    icon: 'roster',
    show: (i) => can(i, 'ROSTER', 'modify') || (!i.atWork && can(i, 'ROSTER')),
  },
  {
    key: 'events',
    href: '/events',
    label: 'Events',
    icon: 'star',
    show: (i) => can(i, 'EVENTS'),
  },
  {
    key: 'reports',
    href: '/reports',
    label: 'Reports',
    icon: 'pie',
    show: (i) => i.reports === 'business',
  },
  {
    key: 'admin',
    href: '/admin',
    label: 'Admin',
    icon: 'gear',
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
 * What everyone who works shifts holds (ADR 106): self-service (the user-based groups) and the
 * groups of the WORKS_SHIFTS duty, each domain at its highest access. Product data, the same
 * for every customer.
 */
export const EVERYONES_ACCESS: ReadonlyMap<string, Access> = (() => {
  const shifts = new Set(DUTY_BY_CODE.get('WORKS_SHIFTS')?.grants.map((g) => g.group) ?? []);
  const out = new Map<string, Access>();
  for (const g of ACCESS_GROUPS) {
    if (g.kind !== 'user_based' && !shifts.has(g.code)) continue;
    for (const [d, a] of Object.entries(g.grants)) {
      if (out.get(d) !== 'modify') out.set(d, a);
    }
  }
  return out;
})();

/**
 * Whether the person's access to a domain is their own work (ADR 106): more than what
 * everyone who works shifts holds. A pool attendant's Stock (his department's store) is; the
 * logbook, registers, breakage and linen every shift worker may write are not, nor are the
 * events they may read. Reads only the access the database returned.
 */
export function ownWork(i: ScreenInput, domain: string): boolean {
  const mine = i.access.get(domain);
  if (!mine) return false;
  const everyone = EVERYONES_ACCESS.get(domain);
  return !everyone || (everyone === 'view' && mine === 'modify');
}

/** First on Me wherever the person has them (ADR 106). */
const FIRST: readonly ScreenKey[] = ['clock', 'shifts', 'leave', 'sops', 'problem'];

/** Screens that are tabs of the Stock screen: their own tile only without Stock (ADR 048). */
const STOCK_TABS: ReadonlySet<ScreenKey> = new Set([
  'count',
  'wastage',
  'orders',
  'transfers',
  'bills',
  'check',
]);

/** The domains whose own access makes each work tile the person's (ADR 106). */
const OWN_DOMAINS: Partial<Record<ScreenKey, readonly string[]>> = {
  tasks: ['TASKS'],
  stock: ['STOCK_LEVELS'],
  count: ['STOCK_ADJUSTMENTS'],
  wastage: ['STOCK_ADJUSTMENTS'],
  check: ['STOCK_CHECK'],
  orders: ['PURCHASE_ORDERS'],
  transfers: ['TRANSFERS'],
  bills: ['BILLS'],
  sales: ['SALES', 'DERIVED_SALES'],
  posImport: ['POS_IMPORT'],
  briefing: ['BRIEFING'],
  minibar: ['MINIBAR'],
  rooms: ['ROOMS'],
  logbook: ['LOGBOOK'],
  registers: ['REGISTERS'],
  utilities: ['UTILITIES'],
  breakage: ['BREAKAGE'],
  training: ['TRAINING'],
  excise: ['EXCISE'],
  audits: ['AUDITS'],
  linen: ['LINEN'],
  compliance: ['COMPLIANCE'],
  roster: ['ROSTER'],
  events: ['EVENTS'],
  swaps: ['SHIFT_SWAPS'],
};

function isOwn(s: Screen, i: ScreenInput): boolean {
  switch (s.key) {
    // shown only where there is something of theirs to open (the shell's checks)
    case 'make':
    case 'opened':
    case 'breakfast':
    case 'reports':
    case 'admin':
      return true;
    // recipes for those who make what is in them, or who see the recipes of the stores they use
    case 'menu':
      return i.production || ['MENU', 'DERIVED_MENU', 'RECIPES'].some((d) => ownWork(i, d));
    default: {
      if (STOCK_TABS.has(s.key) && canOpen('stock', i)) return false;
      return (OWN_DOMAINS[s.key] ?? []).some((d) => ownWork(i, d));
    }
  }
}

/**
 * Me's tiles for one person (ADR 106): first Clock, My shifts, Leave, SOPs and Report a problem
 * where they have them, then the work their own duties give them; the rest under "More".
 * `hide` leaves out what the bottom nav already offers. Nothing is folded when fewer than three
 * would be on either side (an account owner's few screens, a short list of extras).
 */
export function meTiles(
  i: ScreenInput,
  hide: ReadonlySet<string> = new Set(),
): { mine: Screen[]; more: Screen[] } {
  const all = screensFor(i).filter((s) => !hide.has(s.href));
  const first = FIRST.flatMap((k) => all.filter((s) => s.key === k));
  const own = all.filter((s) => !FIRST.includes(s.key) && isOwn(s, i));
  const mine = [...first, ...own];
  const more = all.filter((s) => !mine.includes(s));
  return mine.length < 3 || more.length < 3
    ? { mine: [...mine, ...more], more: [] }
    : { mine, more };
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
