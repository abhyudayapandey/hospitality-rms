import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatMoney, formatWhen } from '@/lib/format';
import { PO_PROGRESS as PROGRESS, supplyContext, type SearchParams } from '@/lib/inventory';

export default async function OrdersPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'orders');
  if (!ctx.can('PURCHASE_ORDERS') || !ctx.node) return <NoSupplyAccess />;
  const user = await requireUser();
  const rows = await withUser(user.id, async (tx) => {
    const r = await sql<{
      id: string;
      supplier: string;
      total: string;
      progress: string;
      created_at: Date;
    }>`
      select po.id, s.name as supplier, po.total, po.progress, po.created_at
        from inv.purchase_order_summary po join inv.supplier s on s.id = po.supplier_id
       where po.delivery_node_id = ${ctx.node!.id}::uuid
       order by po.created_at desc limit 30`.execute(tx);
    return r.rows;
  });
  const q = `?node=${ctx.node.id}`;
  return (
    <div className="space-y-4">
      <PollRefresh />
      <SupplyHeader ctx={ctx} active="/stock/orders" title="Purchase orders" />
      {ctx.can('PURCHASE_ORDERS', 'modify') && !ctx.node.derived && (
        <Link
          href={`/stock/orders/new${q}`}
          className="flex min-h-12 items-center justify-center rounded-lg bg-slate-900 font-medium text-white"
        >
          New order
        </Link>
      )}
      {rows.length === 0 ? (
        <Empty>No purchase orders here yet.</Empty>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const [label, style] = PROGRESS[r.progress] ?? [r.progress, ''];
            return (
              <li key={r.id} data-testid="po-item" data-po-id={r.id}>
                <Link
                  href={`/stock/orders/${r.id}${q}`}
                  className="block rounded-xl bg-white p-4 ring-1 ring-slate-200"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{r.supplier}</span>
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
