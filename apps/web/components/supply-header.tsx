import Link from 'next/link';
import type { SupplyContext } from '@/lib/inventory';
import { PlaceSwitcher } from './place-switcher';

const TABS = [
  { href: '/stock', label: 'Stock', domain: 'STOCK_LEVELS', access: 'view' },
  { href: '/stock/count', label: 'Count', domain: 'STOCK_ADJUSTMENTS', access: 'modify' },
  { href: '/stock/wastage', label: 'Wastage', domain: 'STOCK_ADJUSTMENTS', access: 'modify' },
  { href: '/stock/production', label: 'Production', domain: null, access: 'modify' },
  { href: '/stock/orders', label: 'Orders', domain: 'PURCHASE_ORDERS', access: 'view' },
  { href: '/stock/transfers', label: 'Transfers', domain: 'TRANSFERS', access: 'view' },
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
}: {
  ctx: SupplyContext;
  active: (typeof TABS)[number]['href'];
  title: string;
}) {
  const node = ctx.node!;
  const q = `?node=${node.id}`;
  const tabs = TABS.filter((t) =>
    t.domain === null ? ctx.shell.production : ctx.can(t.domain, t.access),
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
      />
      <h1 className="text-xl font-semibold">{title}</h1>
      {tabs.length > 1 && (
        <nav aria-label="Supply" className="-mx-4 overflow-x-auto px-4">
          <ul className="flex gap-2">
            {tabs.map((t) => (
              <li key={t.href}>
                <Link
                  href={`${t.href}${q}`}
                  aria-current={t.href === active ? 'page' : undefined}
                  className={`flex min-h-11 items-center rounded-full px-4 text-sm whitespace-nowrap ${
                    t.href === active
                      ? 'bg-slate-900 font-semibold text-white'
                      : 'bg-white text-slate-700 ring-1 ring-slate-300'
                  }`}
                >
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}

export function NoSupplyAccess() {
  return <p className="text-slate-600">You don&apos;t have access to stock.</p>;
}
