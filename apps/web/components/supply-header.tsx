import Link from 'next/link';
import type { SupplyContext } from '@/lib/inventory';
import { NodePicker } from './node-picker';

const TABS = [
  { href: '/stock', label: 'Stock', domain: 'STOCK_LEVELS', access: 'view' },
  { href: '/stock/count', label: 'Count', domain: 'STOCK_ADJUSTMENTS', access: 'modify' },
  { href: '/stock/wastage', label: 'Wastage', domain: 'STOCK_ADJUSTMENTS', access: 'modify' },
  { href: '/stock/production', label: 'Production', domain: 'PRODUCTION', access: 'modify' },
  { href: '/stock/orders', label: 'Orders', domain: 'PURCHASE_ORDERS', access: 'view' },
  { href: '/stock/transfers', label: 'Transfers', domain: 'TRANSFERS', access: 'view' },
] as const;

/** Title, supply location picker and the supply tabs the user has access to. */
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
  const tabs = TABS.filter((t) => ctx.can(t.domain, t.access));
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="truncate text-sm text-slate-600" data-testid="supply-node">
          {node.name}
          {node.derived ? ' (view only)' : ''}
        </p>
      </div>
      <NodePicker
        nodes={ctx.nodes.map((n) => ({
          id: n.id,
          label: `${n.name}${n.derived ? ' (view)' : ''}`,
        }))}
        current={node.id}
      />
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
    </div>
  );
}

export function NoSupplyAccess() {
  return <p className="text-slate-600">You don&apos;t have access to stock.</p>;
}
