import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatMoney, formatWhen } from '@/lib/format';
import { PO_PROGRESS as PROGRESS, param, supplyContext, type SearchParams } from '@/lib/inventory';
import { ViewTabs } from '@/components/view-tabs';
import { listHref } from '@/lib/stock-view';

export default async function OrdersPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'orders');
  if (!ctx.can('PURCHASE_ORDERS') || !ctx.node) return <NoSupplyAccess />;
  const sp = await searchParams;
  // "All stores" and the "To receive" tab: what Home's Receive count opens (ADR 048)
  const all = param(sp, 'all') === '1' && ctx.nodes.length > 1;
  const tab = param(sp, 'tab') === 'receive' ? 'receive' : 'all';
  const user = await requireUser();
  const node = ctx.node;
  const rows = await withUser(user.id, async (tx) => {
    const r = await sql<{
      id: string;
      supplier: string;
      store_id: string;
      total: string;
      progress: string;
      created_at: Date;
    }>`
      select po.id, s.name as supplier, po.delivery_node_id::text as store_id, po.total, po.progress, po.created_at
        from inv.purchase_order_summary po
        join inv.supplier s on s.id = po.supplier_id
       where ${
         all
           ? sql`po.delivery_node_id = any(${ctx.nodes.map((n) => n.id)}::uuid[])`
           : sql`po.delivery_node_id = ${node.id}::uuid`
       }
         and (${tab === 'receive'} = false or po.progress in ('released', 'partially_received'))
       order by po.created_at desc limit 30`.execute(tx);
    const names = new Map(ctx.nodes.map((n) => [n.id, n.name]));
    return r.rows.map((x) => ({ ...x, store: names.get(x.store_id) ?? '' }));
  });
  const toReceive = rows.filter(
    (r) => r.progress === 'released' || r.progress === 'partially_received',
  ).length;
  const q = `?node=${node.id}`;
  return (
    <div className="space-y-4">
      <PollRefresh />
      <SupplyHeader
        ctx={ctx}
        active="/stock/orders"
        title="Purchase orders"
        all={ctx.nodes.length > 1 ? { label: 'All stores', on: all } : undefined}
      />
      <ViewTabs
        label="Orders view"
        current={tab}
        tabs={[
          {
            key: 'all',
            label: 'All orders',
            href: listHref('/stock/orders', { all, node: node.id }),
          },
          {
            key: 'receive',
            label: 'To receive',
            count: tab === 'receive' ? rows.length : toReceive,
            href: listHref('/stock/orders', { all, node: node.id, tab: 'receive' }),
          },
        ]}
      />
      {!all && ctx.can('PURCHASE_ORDERS', 'modify') && !node.derived && (
        <Link
          href={`/stock/orders/new${q}`}
          className="flex min-h-12 items-center justify-center rounded-lg bg-brand-700 font-medium text-white"
        >
          New order
        </Link>
      )}
      {rows.length === 0 ? (
        <Empty>
          {tab === 'receive'
            ? 'Nothing is waiting to be received.'
            : 'No purchase orders here yet.'}
        </Empty>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const [label, style] = PROGRESS[r.progress] ?? [r.progress, ''];
            return (
              <li key={r.id} data-testid="po-item" data-po-id={r.id}>
                <Link
                  href={`/stock/orders/${r.id}?node=${r.store_id}`}
                  className="block rounded-xl bg-white p-4 ring-1 ring-slate-200"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {r.supplier}
                      {all && (
                        <span
                          className="block text-xs font-normal text-slate-500"
                          data-testid="order-store"
                        >
                          {r.store}
                        </span>
                      )}
                    </span>
                    <span className="font-semibold tabular-nums">{formatMoney(r.total)}</span>
                  </span>
                  <span className="mt-1 flex items-center justify-between text-sm text-slate-600">
                    {formatWhen(r.created_at)}
                    <span
                      data-testid="po-progress"
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}
                    >
                      {label}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
