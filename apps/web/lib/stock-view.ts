// One Stock screen with four tabs (ADR 048): every way into it, from Home's counts, the
// banners, the menu, an old push link, builds its URL here, so the tab and the Place
// ("All stores" or one) are the same wherever the person came from. Pure.

export type StockTab = 'all' | 'low' | 'expiring' | 'expired';

export const STOCK_TABS: readonly { key: StockTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'low', label: 'Running low' },
  { key: 'expiring', label: 'Expiring in 3 days' },
  { key: 'expired', label: 'Expired' },
];

/** The tab asked for: ?tab=, or the older ?low=1 / ?below=1 and /stock/expiry?show=. */
export function stockTab(p: {
  tab?: string | undefined;
  low?: string | undefined;
  below?: string | undefined;
  show?: string | undefined;
}): StockTab {
  const t = p.tab ?? '';
  if (t === 'low' || t === 'expiring' || t === 'expired') return t;
  if (p.low === '1' || p.below === '1') return 'low';
  if (p.show === 'expired') return 'expired';
  if (p.show === 'expiring') return 'expiring';
  return 'all';
}

/**
 * /stock on a tab. `all` is every store the person sees ("All stores" in the Place picker);
 * otherwise `node` is the one store (or none: the remembered one).
 */
export function stockHref(o: { tab?: StockTab; all?: boolean; node?: string | null } = {}): string {
  const q: string[] = [];
  if (o.node) q.push(`node=${o.node}`);
  if (o.all) q.push('all=1');
  if (o.tab && o.tab !== 'all') q.push(`tab=${o.tab}`);
  return q.length > 0 ? `/stock?${q.join('&')}` : '/stock';
}

/**
 * A list screen (orders, transfers, ...) with its Place and tab: the same scope rule as
 * Stock. `all` is every place the person sees; otherwise `node` is the one place.
 */
export function listHref(
  path: string,
  o: {
    all?: boolean;
    node?: string | null;
    tab?: string | null;
    week?: string | null;
    day?: string | null;
    /** how many rows to show ("Show more", ADR 052) */
    n?: number | null;
  } = {},
): string {
  const q: string[] = [];
  if (o.node) q.push(`node=${o.node}`);
  if (o.all) q.push('all=1');
  if (o.tab && o.tab !== 'all') q.push(`tab=${o.tab}`);
  if (o.week) q.push(`week=${o.week}`);
  if (o.day) q.push(`day=${o.day}`);
  if (o.n) q.push(`n=${o.n}`);
  return q.length > 0 ? `${path}?${q.join('&')}` : path;
}
