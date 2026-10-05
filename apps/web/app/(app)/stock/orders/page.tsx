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

// Orders (ADR 048, 049, 051): one list with the store's own orders and, for the Main Store's
// keeper, the departments' requests they order and receive (the order desk). Tabs: All, To
// order (the desk), To receive, Received. The list comes first; asking for supplies is below
// it, a secondary link for the Main Store, which is asked rather than asking.

const TABS = ['all', 'to_order', 'receive', 'received'] as const;
type Tab = (typeof TABS)[number];

interface Row {
  id: string;
  supplier: string | null;
  store_id: string;
  store: string;
  progress: string;
  created_at: Date;
  items: string | null;
  value: string | null;
  bill_missing: boolean;
  desk: boolean;
}

const inTab = (r: Row, t: Tab) =>
  t === 'all' ||
  (t === 'to_order' && r.progress === 'to_order') ||
  (t === 'receive' && (r.progress === 'released' || r.progress === 'partially_received')) ||
  (t === 'received' && r.progress === 'received');

export default async function OrdersPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'orders');
  if (!ctx.can('PURCHASE_ORDERS') || !ctx.node) return <NoSupplyAccess />;
  const sp = await searchParams;
  // "All stores" and the "To receive" tab: what Home's Receive count opens (ADR 048)
  const all = param(sp, 'all') === '1' && ctx.nodes.length > 1;
  const raw = param(sp, 'tab');
  const user = await requireUser();
  const node = ctx.node;
  const nodes = all ? ctx.nodes.map((n) => n.id) : [node.id];
  const names = new Map(ctx.nodes.map((n) => [n.id, n.name]));
  const { rows, mainStore } = await withUser(user.id, async (tx) => {
    const own = await sql<Omit<Row, 'store' | 'desk'>>`
      select po.id, s.name as supplier, po.delivery_node_id::text as store_id, po.progress,
             po.created_at,
             (select string_agg(i.name, ', ' order by i.name)
                from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
               where pl.po_id = po.id) as items,
             inv.po_received_value(po.id) as value,
             coalesce(inv.po_bill_missing(po.id), false) as bill_missing
        from inv.purchase_order_summary po
        left join inv.supplier s on s.id = po.supplier_id
       where po.delivery_node_id = any(${nodes}::uuid[])
       order by po.created_at desc limit 60`.execute(tx);
    // the departments' requests this person orders and receives for (ADR 049)
    const desk = await sql<{
      po_id: string;
      store_id: string;
      store: string;
      supplier: string | null;
      progress: string;
      created_at: Date;
      items: string | null;
      bill_missing: boolean;
    }>`select po_id, store_id::text, store, supplier, progress, created_at, items,
              coalesce(bill_missing, false) as bill_missing
         from inv.desk_order_list()`.execute(tx);
    const main = await sql<{ m: boolean }>`select inv.is_main_store(${node.id}::uuid) as m`.execute(
      tx,
    );
    const seen = new Set(own.rows.map((r) => r.id));
    const deskRows: Row[] = [];
    for (const d of desk.rows) {
      if (seen.has(d.po_id)) continue;
      const value = await sql<{ v: string | null }>`
        select inv.po_received_value(${d.po_id}::uuid) as v`.execute(tx);
      deskRows.push({
        id: d.po_id,
        supplier: d.supplier,
        store_id: d.store_id,
        store: d.store,
        progress: d.progress,
        created_at: d.created_at,
        items: d.items,
        value: value.rows[0]?.v ?? null,
        bill_missing: d.bill_missing,
        desk: true,
      });
    }
    const merged: Row[] = [
      ...own.rows.map((r) => ({ ...r, store: names.get(r.store_id) ?? '', desk: false })),
      ...deskRows,
    ].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
    return { rows: merged, mainStore: main.rows[0]?.m ?? false };
  });
  const count = (t: Tab) => rows.filter((r) => inTab(r, t)).length;
  const showToOrder = count('to_order') > 0;
  const tab: Tab =
    (TABS as readonly string[]).includes(raw ?? '') && (raw !== 'to_order' || showToOrder)
      ? (raw as Tab)
      : 'all';
  const list = rows.filter((r) => inTab(r, tab));
  const href = (t: Tab) => listHref('/stock/orders', { all, node: node.id, tab: t });
  const canAsk = !all && ctx.can('PURCHASE_ORDERS', 'modify') && !node.derived;
  const ask = `/stock/orders/new?node=${node.id}`;
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
          { key: 'all', label: 'All orders', href: href('all') },
          ...(showToOrder
            ? [
                {
                  key: 'to_order',
                  label: 'To order',
                  count: count('to_order'),
                  href: href('to_order'),
                },
              ]
            : []),
          { key: 'receive', label: 'To receive', count: count('receive'), href: href('receive') },
          { key: 'received', label: 'Received', count: count('received'), href: href('received') },
        ]}
      />
      {list.length === 0 ? (
        <Empty>
          {tab === 'receive'
            ? 'Nothing is waiting to be received.'
            : tab === 'received'
              ? 'Nothing received yet.'
              : 'No orders here yet.'}
        </Empty>
      ) : (
        <ul className="space-y-2">
          {list.map((r) => {
            const [label, style] = PROGRESS[r.progress] ?? [r.progress, ''];
            const received = r.progress === 'received' || r.progress === 'partially_received';
            return (
              <li key={r.id} data-testid="po-item" data-po-id={r.id}>
                <Link
                  href={`/stock/orders/${r.id}?node=${r.desk ? node.id : r.store_id}`}
                  className="block rounded-xl bg-white p-4 ring-1 ring-slate-200"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 font-medium">
                      {r.supplier ?? 'Supplies request'}
                      {(all || r.desk) && (
                        <span
                          className="block text-xs font-normal text-slate-500"
                          data-testid="order-store"
                        >
                          for {r.store}
                        </span>
                      )}
                    </span>
                    {received && r.value && (
                      <span className="font-semibold tabular-nums">{formatMoney(r.value)}</span>
                    )}
                  </span>
                  {r.items && (
                    <span className="mt-1 block truncate text-sm text-slate-600">{r.items}</span>
                  )}
                  <span className="mt-1 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
                    {formatWhen(r.created_at)}
                    <span className="flex gap-1">
                      {received && r.bill_missing && (
                        <span
                          data-testid="bill-missing"
                          className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900"
                        >
                          Bill missing
                        </span>
                      )}
                      <span
                        data-testid="po-progress"
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}
                      >
                        {label}
                      </span>
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {canAsk &&
        (mainStore ? (
          // the Main Store is asked for supplies; asking for itself is the exception
          <Link
            href={ask}
            className="flex min-h-11 items-center justify-center text-sm font-medium text-brand-700 underline"
          >
            Ask for supplies for the Main Store
          </Link>
        ) : (
          <Link
            href={ask}
            className="flex min-h-12 items-center justify-center rounded-lg bg-brand-700 font-medium text-white"
          >
            Ask for supplies
          </Link>
        ))}
    </div>
  );
}
