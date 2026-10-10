import Link from 'next/link';
import { ItemThumbs } from '@/components/item-thumb';
import { PinnedActions } from '@/components/pinned-actions';
import { withBack } from '@/lib/back';
import { Empty } from '@/components/messages';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatMoney, formatWhen } from '@/lib/format';
import { formatDay } from '@/lib/dates';
import {
  PO_PROGRESS as PROGRESS,
  param,
  SUPPLY_PROGRESS,
  supplyContext,
  type SearchParams,
} from '@/lib/inventory';
import { LIST_PAGE, listLimit } from '@/lib/list-page';
import { ShowMore } from '@/components/show-more';
import { ViewTabs } from '@/components/view-tabs';
import { listHref } from '@/lib/stock-view';

// Orders (ADR 048, 049, 051, 052): one list with the store's own orders and, for the Main
// Store's keeper, the departments' requests they order and receive (the order desk). Tabs:
// All, To order (the desk), To receive (a department: On the way), Received. Each tab's count
// is the whole list, counted in SQL; the list shows a page at a time. The list comes first;
// asking for supplies is below it, a secondary link for the Main Store.

const TABS = ['all', 'to_order', 'receive', 'received'] as const;
type Tab = (typeof TABS)[number];

interface Row {
  id: string;
  supplier: string | null;
  store_id: string;
  store: string;
  progress: string;
  created_at: Date;
  /** the day it is due (ADR 049) */
  expected_on: string | null;
  items: string | null;
  value: string | null;
  bill_missing: boolean;
  desk: boolean;
  /** a department's order its Main Store places and receives: no ₹, "on the way" (ADR 052) */
  follow: boolean;
}

// which tab a progress belongs to; closed orders (the rest is not coming) are done
const BUCKET = sql`case progress when 'to_order' then 'to_order'
                                 when 'released' then 'receive'
                                 when 'partially_received' then 'receive'
                                 when 'received' then 'received'
                                 when 'closed' then 'received'
                                 else 'other' end`;

export default async function OrdersPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'orders');
  if (!ctx.can('PURCHASE_ORDERS') || !ctx.node) return <NoSupplyAccess />;
  const sp = await searchParams;
  // "All stores" and the "To receive" tab: what Home's Receive count opens (ADR 048)
  const all = param(sp, 'all') === '1' && ctx.nodes.length > 1;
  const raw = param(sp, 'tab');
  const limit = listLimit(param(sp, 'n'));
  const user = await requireUser();
  const node = ctx.node;
  const nodes = all ? ctx.nodes.map((n) => n.id) : [node.id];
  const asked = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'all';
  const { rows, counts, mainStore, follows } = await withUser(user.id, async (tx) => {
    // the store's own orders and the departments' requests this person orders and receives
    // for (ADR 049); counted with no limit, listed a page at a time (ADR 052)
    const scope = sql`
      with o as (
        select po.id, s.name as supplier, po.delivery_node_id as store_id,
               core.node_name(po.delivery_node_id) as store, po.progress, po.created_at,
               (select string_agg(i.name, ', ' order by i.name)
                  from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
                 where pl.po_id = po.id) as items,
               false as desk
          from inv.purchase_order_summary po
          left join inv.supplier s on s.id = po.supplier_id
         where po.delivery_node_id = any(${nodes}::uuid[])
        union all
        select d.po_id, d.supplier, d.store_id, d.store, d.progress, d.created_at, d.items, true
          from inv.desk_order_list() d
         where not (d.store_id = any(${nodes}::uuid[])))
      select *, ${BUCKET} as bucket from o`;
    const c = await sql<{ bucket: string; n: number }>`
      select bucket, count(*)::int as n from (${scope}) x group by bucket`.execute(tx);
    const r = await sql<Row>`
      select id, supplier, store_id::text, store, progress, created_at, items, desk,
             (select p.expected_on::text from inv.purchase_order p where p.id = x.id)
               as expected_on,
             inv.po_received_value(id) as value,
             coalesce(inv.po_bill_missing(id), false) as bill_missing,
             inv.follows_order(id) as follow
        from (${scope}) x
       where ${asked} = 'all' or bucket = ${asked}
       order by created_at desc, id
       limit ${limit + 1}`.execute(tx);
    const facts = await sql<{ m: boolean; follows: boolean }>`
      select inv.is_main_store(${node.id}::uuid) as m,
             inv.follows_store(${node.id}::uuid) as follows`.execute(tx);
    return {
      rows: r.rows,
      counts: new Map(c.rows.map((x) => [x.bucket, x.n])),
      mainStore: facts.rows[0]?.m ?? false,
      follows: !all && (facts.rows[0]?.follows ?? false),
    };
  });
  const count = (t: Exclude<Tab, 'all'>) => counts.get(t) ?? 0;
  const showToOrder = count('to_order') > 0;
  const tab: Tab = asked !== 'to_order' || showToOrder ? asked : 'all';
  const list = tab === asked ? rows.slice(0, limit) : [];
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
          {
            key: 'receive',
            // a department whose Main Store receives for it follows its orders (ADR 052)
            label: follows ? 'On the way' : 'To receive',
            count: count('receive'),
            href: href('receive'),
          },
          { key: 'received', label: 'Received', count: count('received'), href: href('received') },
        ]}
      />
      {list.length === 0 ? (
        <Empty>
          {tab === 'receive'
            ? follows
              ? 'Nothing is on the way.'
              : 'Nothing is waiting to be received.'
            : tab === 'received'
              ? 'Nothing received yet.'
              : 'No orders here yet.'}
        </Empty>
      ) : (
        <ul className="space-y-2">
          {list.map((r) => {
            const [label, style] = (r.follow ? SUPPLY_PROGRESS : PROGRESS)[r.progress] ?? [
              r.progress,
              '',
            ];
            const received =
              r.progress === 'received' ||
              r.progress === 'partially_received' ||
              r.progress === 'closed';
            return (
              <li key={r.id} data-testid="po-item" data-po-id={r.id}>
                <Link
                  href={withBack(
                    `/stock/orders/${r.id}?node=${r.desk ? node.id : r.store_id}`,
                    listHref('/stock/orders', { all, node: node.id, tab }),
                  )}
                  className="block rounded-xl bg-white p-4 ring-1 ring-slate-200"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 font-medium">
                      {r.supplier ?? 'Supply request'}
                      {(all || r.desk) && (
                        <span
                          className="block text-xs font-normal text-slate-500"
                          data-testid="order-store"
                        >
                          for {r.store}
                        </span>
                      )}
                    </span>
                    {received && r.value && !r.follow && (
                      <span className="font-semibold tabular-nums">{formatMoney(r.value)}</span>
                    )}
                  </span>
                  {r.items && (
                    <span className="mt-1 flex items-center gap-2">
                      <ItemThumbs names={r.items} />
                      <span className="min-w-0 truncate text-sm text-slate-600">{r.items}</span>
                    </span>
                  )}
                  <span className="mt-1 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
                    {/* what is still to come says when it is due first (ADR 113) */}
                    {!received && r.expected_on ? (
                      <span data-testid="order-due">
                        <span className="font-semibold text-slate-800">
                          Due {formatDay(r.expected_on)}
                        </span>{' '}
                        · placed {formatWhen(r.created_at)}
                      </span>
                    ) : (
                      formatWhen(r.created_at)
                    )}
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
      {tab === asked && rows.length > limit && (
        <ShowMore
          href={listHref('/stock/orders', { all, node: node.id, tab, n: limit + LIST_PAGE })}
        />
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
          // kept in reach while the list runs past the screen (ADR 101)
          <PinnedActions label="Main actions">
            <Link
              href={ask}
              className="flex min-h-12 items-center justify-center rounded-lg bg-brand-700 font-medium text-white"
            >
              Ask for supplies
            </Link>
          </PinnedActions>
        ))}
    </div>
  );
}
