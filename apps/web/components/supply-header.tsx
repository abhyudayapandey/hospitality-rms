import Link from 'next/link';
import type { SupplyContext } from '@/lib/inventory';
import { PlaceSwitcher } from './place-switcher';
import { splitTabs } from '@/lib/supply-tabs';
import { MoreTabs } from './more-tabs';

// in the order a store works: the first 4 a person has, then More / Less (ADR 053, 054)
const TABS = [
  { href: '/stock', label: 'Stock', domain: 'STOCK_LEVELS', access: 'view' },
  { href: '/stock/orders', label: 'Orders', domain: 'PURCHASE_ORDERS', access: 'view' },
  { href: '/stock/transfers', label: 'Transfers', domain: 'TRANSFERS', access: 'view' },
  { href: '/stock/count', label: 'Count', domain: 'STOCK_ADJUSTMENTS', access: 'modify' },
  { href: '/stock/wastage', label: 'Wastage', domain: 'STOCK_ADJUSTMENTS', access: 'modify' },
  { href: '/stock/opened', label: 'Opened', domain: 'SHELF_LIFE', access: 'view' },
  { href: '/stock/production', label: 'Make', domain: null, access: 'modify' },
  { href: '/stock/check', label: 'Stock check', domain: 'STOCK_CHECK', access: 'view' },
  { href: '/stock/bills', label: 'Bills', domain: 'BILLS', access: 'view' },
] as const;

/**
 * Title, the "Place:" switcher of this screen's stock locations, and the supply tabs the
 * user has. Production shows only to people with a store where something is made that
 * they may record (audit #4). Tab links carry the place; the next screen keeps it if it
 * offers it there.
 */
export function SupplyHeader({
  ctx,
  active,
  title,
  all,
}: {
  ctx: SupplyContext;
  active: (typeof TABS)[number]['href'];
  title: string;
  /** an "All stores" option in the switcher, for lists across the stores (ADR 038) */
  all?: { label: string; on: boolean } | undefined;
}) {
  const node = ctx.node!;
  const q = `?node=${node.id}`;
  const tabs = TABS.filter((t) =>
    t.domain === null ? ctx.shell.production : ctx.can(t.domain, t.access),
  );
  const { shown, more, open } = splitTabs(tabs, active);
  const pill = (t: (typeof TABS)[number]) => (
    <Link
      href={`${t.href}${q}`}
      aria-current={t.href === active ? 'page' : undefined}
      className={`flex min-h-11 items-center rounded-full px-4 text-sm whitespace-nowrap ${
        t.href === active
          ? 'bg-brand-700 font-semibold text-white'
          : 'bg-white text-slate-700 ring-1 ring-slate-300'
      }`}
    >
      {t.label}
    </Link>
  );
  return (
    <div className="space-y-3">
      <PlaceSwitcher
        screen={ctx.screen}
        places={ctx.nodes.map((n) => ({
          id: n.id,
          name: `${n.name}${n.derived ? ' (view only)' : ''}`,
        }))}
        current={node.id}
        all={all}
      />
      <h1 className="text-xl font-semibold">{title}</h1>
      {tabs.length > 1 && (
        <nav aria-label="Stock tabs" className="px-0">
          <MoreTabs
            shown={shown.map((t) => (
              <li key={t.href}>{pill(t)}</li>
            ))}
            more={more.map((t) => (
              <li key={t.href}>{pill(t)}</li>
            ))}
            open={open}
          />
        </nav>
      )}
    </div>
  );
}

export function NoSupplyAccess() {
  // a way back, not a dead end (ADR 053)
  return (
    <div className="space-y-3">
      <p className="text-slate-600">You don&apos;t have access to stock.</p>
      <Link href="/" className="flex min-h-11 items-center text-sm font-medium text-brand-700">
        ← Home
      </Link>
    </div>
  );
}
