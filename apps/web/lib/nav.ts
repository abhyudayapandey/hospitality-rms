// Bottom navigation. Items tied to a domain are shown only when core.my_domains() lists
// that domain; Menu and Production only where there is something to open (audit, ADR 016).
// This is presentation only: RLS and the RPCs enforce access (ADR 004).

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Shown when the user has any of these domains. */
  domains?: readonly string[];
}

export interface NavFeatures {
  /** a recipe they may read, or menu costs somewhere */
  menu: boolean;
  /** a store where they record production */
  production: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Home', icon: '⌂' },
  { href: '/inbox', label: 'Inbox', icon: '✓' },
  { href: '/requests', label: 'Requests', icon: '≡' },
  { href: '/stock', label: 'Stock', icon: '▦', domains: ['STOCK_LEVELS'] },
  // menu costs for MENU holders, otherwise the recipes and procedures they may read
  { href: '/menu', label: 'Menu', icon: '☰' },
  { href: '/roster', label: 'Roster', icon: '◷', domains: ['ROSTER'] },
  // user administration (ADR 011) as well as the security roles view
  { href: '/admin', label: 'Admin', icon: '⚙', domains: ['USER_ACCESS', 'SECURITY_ROLES'] },
];

const PRODUCTION_ITEM: NavItem = { href: '/stock/production', label: 'Production', icon: '▦' };

export function visibleNav(domains: ReadonlySet<string>, features: NavFeatures): NavItem[] {
  return NAV_ITEMS.flatMap((i) => {
    if (i.href === '/menu') return features.menu ? [i] : [];
    if (i.href === '/stock' && !domains.has('STOCK_LEVELS')) {
      // cooks and bartenders who only record batches (PRODUCTION_TEAM)
      return features.production ? [PRODUCTION_ITEM] : [];
    }
    return !i.domains || i.domains.some((d) => domains.has(d)) ? [i] : [];
  });
}
