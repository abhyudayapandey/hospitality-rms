import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { ViewTabs } from '@/components/view-tabs';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { param, supplyContext, type SearchParams } from '@/lib/inventory';
import { listHref } from '@/lib/stock-view';

// Vendor bills (BIL-3, ADR 050): every bill at the person's stores, for goods and services,
// and the orders received without one. "All stores" first when there are several (ADR 038).

const TABS = ['all', 'goods', 'services', 'waiting'] as const;
type Tab = (typeof TABS)[number];

interface BillRow {
  id: string;
  kind: 'goods' | 'service';
  supplier: string | null;
  bill_no: string | null;
  bill_date: Date;
  amount: string;
  description: string | null;
  store_id: string;
}

interface WaitingRow {
  id: string;
  supplier: string | null;
  store_id: string;
  /** what was received and what it cost (the receipts), never the order's estimate */
  received: string;
  released_at: Date | null;
}

const day = (d: Date | null) =>
  d
    ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    : '';

export default async function BillsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'bills');
  if (!ctx.can('BILLS') || !ctx.node) return <NoSupplyAccess />;
  const sp = await searchParams;
  const all = param(sp, 'all') === '1' && ctx.nodes.length > 1;
  const raw = param(sp, 'tab');
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'all';
  const node = ctx.node;
  const nodes = all ? ctx.nodes.map((n) => n.id) : [node.id];
  const user = await requireUser();
  const { bills, waiting } = await withUser(user.id, async (tx) => {
    const b = await sql<BillRow>`
      select b.id, b.kind, coalesce(s.name, b.supplier_name) as supplier, b.bill_no, b.bill_date,
             b.amount, b.description, b.delivery_node_id::text as store_id
        from inv.bill b
        left join inv.supplier s on s.id = b.supplier_id
       where b.delivery_node_id = any(${nodes}::uuid[]) and b.archived_at is null
         and (${tab} not in ('goods', 'services')
              or b.kind = case ${tab} when 'goods' then 'goods' else 'service' end)
       order by b.bill_date desc, b.created_at desc
       limit 50`.execute(tx);
    // orders received in the last 60 days with no bill yet
    const w = await sql<WaitingRow>`
      select po.id, s.name as supplier, po.delivery_node_id::text as store_id,
             inv.po_received_value(po.id) as received, po.released_at
        from inv.purchase_order_summary po
        left join inv.supplier s on s.id = po.supplier_id
       where po.delivery_node_id = any(${nodes}::uuid[])
         and po.received_qty > 0
         and po.released_at > now() - interval '60 days'
         and not exists (select 1 from inv.bill b where b.po_id = po.id and b.archived_at is null)
       order by po.released_at desc
       limit 50`.execute(tx);
    return { bills: b.rows, waiting: w.rows };
  });
  const names = new Map(ctx.nodes.map((n) => [n.id, n.name]));
  const total = bills.reduce((t, b) => t + Number(b.amount), 0);
  const href = (t: Tab) => listHref('/stock/bills', { all, node: node.id, tab: t });
  return (
    <div className="space-y-4">
      <SupplyHeader
        ctx={ctx}
        active="/stock/bills"
        title="Bills"
        all={ctx.nodes.length > 1 ? { label: 'All stores', on: all } : undefined}
      />
      <ViewTabs
        label="Bills view"
        current={tab}
        tabs={[
          { key: 'all', label: 'All', href: href('all') },
          { key: 'goods', label: 'Goods', href: href('goods') },
          { key: 'services', label: 'Services', href: href('services') },
          {
            key: 'waiting',
            label: 'Waiting for a bill',
            count: waiting.length,
            href: href('waiting'),
          },
        ]}
      />
      {tab === 'waiting' ? (
        waiting.length === 0 ? (
          <Empty>Every order received has its bill.</Empty>
        ) : (
          <ul className="space-y-2">
            {waiting.map((o) => (
              <li key={o.id} data-testid="bill-waiting">
                <Link
                  href={`/stock/orders/${o.id}?node=${o.store_id}`}
                  className="block rounded-xl bg-white p-4 ring-1 ring-slate-200"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {o.supplier ?? 'Supplies request'}
                      {all && (
                        <span className="block text-xs font-normal text-slate-500">
                          {names.get(o.store_id)}
                        </span>
                      )}
                    </span>
                    <span className="text-right text-sm text-slate-600">
                      received for{' '}
                      <span className="font-semibold text-slate-900 tabular-nums">
                        {formatMoney(o.received)}
                      </span>
                    </span>
                  </span>
                  <span className="mt-1 block text-sm text-slate-600">
                    Ordered {day(o.released_at)} · Add the bill
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : bills.length === 0 ? (
        <Empty>No bills here yet.</Empty>
      ) : (
        <>
          <p className="text-sm text-slate-600" data-testid="bills-total">
            {bills.length} {bills.length === 1 ? 'bill' : 'bills'} · {formatMoney(total)}
          </p>
          <ul className="space-y-2">
            {bills.map((b) => (
              <li key={b.id} data-testid="bill-item">
                <Link
                  href={`/stock/bills/${b.id}?node=${b.store_id}`}
                  className="block rounded-xl bg-white p-4 ring-1 ring-slate-200"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 font-medium">
                      {b.supplier}
                      {all && (
                        <span className="block text-xs font-normal text-slate-500">
                          {names.get(b.store_id)}
                        </span>
                      )}
                    </span>
                    <span className="font-semibold tabular-nums">{formatMoney(b.amount)}</span>
                  </span>
                  <span className="mt-1 flex items-center justify-between gap-2 text-sm text-slate-600">
                    <span className="truncate">
                      {day(b.bill_date)}
                      {b.bill_no && ` · ${b.bill_no}`}
                      {b.description && ` · ${b.description}`}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                      {b.kind === 'goods' ? 'goods' : 'service'}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {!all && tab !== 'waiting' && ctx.can('BILLS', 'modify') && !node.derived && (
        <Link
          href={`/stock/bills/new?node=${node.id}`}
          className="flex min-h-12 items-center justify-center rounded-lg bg-brand-700 font-medium text-white"
        >
          Add a bill for a service
        </Link>
      )}
    </div>
  );
}
