import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { ViewTabs } from '@/components/view-tabs';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { param, supplyContext, type SearchParams } from '@/lib/inventory';
import { listHref } from '@/lib/stock-view';
import { ListDays } from '@/components/date-range';
import { BILL_TABS, billList, type BillTab } from '@/lib/bill-list';
import { listDays } from '@/lib/list-days';

// Vendor bills (BIL-3, ADR 050): every bill at the person's stores, for goods and services,
// and the orders received without one. "All stores" first when there are several (ADR 038).

const TABS = BILL_TABS;
type Tab = BillTab;

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
  const { bills, waiting, count, sum, range, today } = await withUser(user.id, async (tx) => {
    const { range, today } = await listDays(tx, sp, node.id);
    return {
      ...(await billList(tx, { nodes, node: node.id, tab, limit: 50, range })),
      range,
      today,
    };
  });
  const names = new Map(ctx.nodes.map((n) => [n.id, n.name]));
  const href = (t: Tab) => listHref('/stock/bills', { all, node: node.id, tab: t, range });
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
      <ListDays
        path="/stock/bills"
        params={{ node: node.id, all: all ? '1' : undefined, tab: tab === 'all' ? undefined : tab }}
        range={range}
        today={today}
        list="bills"
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
            {count} {count === 1 ? 'bill' : 'bills'} · {formatMoney(sum)}
            {count > bills.length && ` · the latest ${bills.length} shown`}
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
