// Bottom navigation. Items tied to a domain are shown only when core.my_domains() lists
// that domain. This is presentation only: RLS and the RPCs enforce access (ADR 004).

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  domain?: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Home', icon: '⌂' },
  { href: '/inbox', label: 'Inbox', icon: '✓' },
  { href: '/requests', label: 'Requests', icon: '≡' },
  { href: '/stock', label: 'Stock', icon: '▦', domain: 'STOCK_LEVELS' },
  { href: '/roster', label: 'Roster', icon: '◷', domain: 'ROSTER' },
  { href: '/admin', label: 'Admin', icon: '⚙', domain: 'SECURITY_ROLES' },
];

export function visibleNav(domains: ReadonlySet<string>): NavItem[] {
  return NAV_ITEMS.filter((i) => !i.domain || domains.has(i.domain));
}
