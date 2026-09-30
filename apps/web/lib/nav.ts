// Bottom navigation. Items tied to a domain are shown only when core.my_domains() lists
// that domain. This is presentation only: RLS and the RPCs enforce access (ADR 004).

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Shown when the user has any of these domains. */
  domains?: readonly string[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Home', icon: '⌂' },
  { href: '/inbox', label: 'Inbox', icon: '✓' },
  { href: '/requests', label: 'Requests', icon: '≡' },
  { href: '/stock', label: 'Stock', icon: '▦', domains: ['STOCK_LEVELS'] },
  { href: '/roster', label: 'Roster', icon: '◷', domains: ['ROSTER'] },
  // user administration (ADR 011) as well as the security roles view
  { href: '/admin', label: 'Admin', icon: '⚙', domains: ['USER_ACCESS', 'SECURITY_ROLES'] },
];

export function visibleNav(domains: ReadonlySet<string>): NavItem[] {
  return NAV_ITEMS.filter((i) => !i.domains || i.domains.some((d) => domains.has(d)));
}
