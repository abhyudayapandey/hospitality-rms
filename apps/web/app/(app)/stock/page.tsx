import Link from 'next/link';
import { ListSearch } from '@/components/list-search';
import { Empty } from '@/components/messages';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { Icon } from '@/components/icon';
import { companySettings } from '@/lib/settings-data';
import { countDue, countDueText, hubActions } from '@/lib/stock-hub';
import { ViewTabs } from '@/components/view-tabs';
import { ExpiryList } from '@/components/expiry-list';
import { ItemThumb } from '@/components/item-thumb';
import { splitExpiry } from '@/lib/expiry';
import { isLow, lastsText } from '@/lib/low-stock';
import { STOCK_TABS, stockHref, stockTab, type StockTab } from '@/lib/stock-view';
import { itemPhotoUrls } from '@/lib/photos';
import {
  expiryList,
  formatQty,
  param,
  stockList,
  stockListAll,
  type StockRow,
  type StockRowAll,
  supplyContext,
  type SearchParams,
} from '@/lib/inventory';

const storeOfRow = (r: StockRow, node: string) => (r as Partial<StockRowAll>).store_id ?? node;

// The one Stock screen (ADR 048): four tabs, All, Running low, Expiring and Expired, and the
// Place picker with "All stores" first (ADR 038). Home's counts, the banners, the menu and
// old push links all arrive here, on the tab that matches what they counted.
export default async function StockPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'stock');
  if (!ctx.can('STOCK_LEVELS') || !ctx.node) return <NoSupplyAccess />;
  const sp = await searchParams;
  const tab = stockTab({
    tab: param(sp, 'tab'),
    low: param(sp, 'low'),
    below: param(sp, 'below'),
    show: param(sp, 'show'),
  });
  // "All stores": every store the person sees, each line naming its store
  const all = param(sp, 'all') === '1' && ctx.nodes.length > 1;
  const user = await requireUser();
  const node = ctx.node;
  const adjust = ctx.can('STOCK_ADJUSTMENTS', 'modify') && !node.derived;
  const data = await withUser(user.id, async (tx) => {
    const rows: StockRowAll[] | StockRow[] = all
      ? await stockListAll(tx, ctx.nodes)
      : await stockList(tx, node.id);
    const dated = splitExpiry(await expiryList(tx), all ? null : node.id);
    // stock on its way here (sent, not yet received); RLS shows only transfers they may see
    const transit =
      !all && ctx.can('TRANSFERS')
        ? Number(
            (
              await sql<{ n: string }>`
              select count(*) as n from inv.transfer_summary
               where to_node_id = ${node.id}::uuid and progress = 'in_transit'`.execute(tx)
            ).rows[0]!.n,
          )
        : 0;
    // the last submitted count here, for "count due" (count_due_days, ADR 035)
    const last =
      adjust && !all
        ? ((
            await sql<{ at: Date | null }>`
            select max(submitted_at) as at from inv.stock_count
             where delivery_node_id = ${node.id}::uuid and status = 'submitted'`.execute(tx)
          ).rows[0]?.at ?? null)
        : null;
    const main = await sql<{ m: boolean }>`select inv.is_main_store(${node.id}::uuid) as m`.execute(
      tx,
    );
    // Running low: where the person may ask for (or order) what is low, per store (ADR 052)
    const lowStores =
      tab === 'low'
        ? (
            await sql<{ id: string; main: boolean }>`
              select x.id::text, inv.is_main_store(x.id) as main
                from unnest(${[...new Set(rows.filter((r) => isLow(r)).map((r) => storeOfRow(r, node.id)))]}::uuid[]) x(id)
               where core.can('PURCHASE_ORDERS', 'modify', null, x.id)`.execute(tx)
          ).rows
        : [];
    return {
      rows,
      dated,
      transit,
      last,
      mainStore: main.rows[0]?.m ?? false,
      lowStores,
      settings: await companySettings(tx),
    };
  });
  const { rows, dated } = data;
  const due = adjust && !all ? countDue(data.last, data.settings.count_due_days) : null;
  const photos = await itemPhotoUrls(rows);
  const low = rows.filter((r) => isLow(r));
  const shown = tab === 'low' ? low : rows;
  const q = `node=${node.id}`;
  const link = (t: StockTab) => stockHref({ tab: t, all, node: node.id });
  const count: Record<StockTab, number> = {
    all: rows.length,
    low: low.length,
    expiring: dated.expiring.length,
    expired: dated.expired.length,
  };
  const actions = all
    ? { main: [], more: [] }
    : hubActions(
        {
          adjust,
          order: ctx.can('PURCHASE_ORDERS', 'modify') && !node.derived,
          request: ctx.can('TRANSFERS', 'modify') && !node.derived && node.holds_stock,
          mainStore: data.mainStore,
        },
        q,
      );
  const storeNames = new Map(ctx.nodes.map((n) => [n.id, n.name]));
  const attention = 'flex min-h-14 items-center gap-3 rounded-xl px-4 py-2 ring-1';
  const categories = [...new Set(shown.map((r) => r.category))];
  const storeOf = (r: StockRow) => storeOfRow(r, node.id);
  return (
    <div className="space-y-4">
      <PollRefresh />
      <SupplyHeader
        ctx={ctx}
        active="/stock"
        title="Stock"
        all={ctx.nodes.length > 1 ? { label: 'All stores', on: all } : undefined}
      />
      {/* on its way here, count due: about one store, so not under "All stores" */}
      {(data.transit > 0 || due?.due) && (
        <div className="space-y-2" data-testid="stock-attention">
          {data.transit > 0 && (
            <Link
              href={`/stock/transfers?${q}`}
              className={`${attention} bg-sky-50 text-sky-900 ring-sky-200`}
              data-testid="attention-transit"
            >
              <Icon name="truck" />
              <span className="flex-1 font-medium">On its way here</span>
              <span className="text-lg font-semibold tabular-nums">{data.transit}</span>
              <Icon name="chevron" className="size-5" />
            </Link>
          )}
          {due?.due && (
            <Link
              href={`/stock/count?${q}`}
              className={`${attention} bg-amber-50 text-amber-900 ring-amber-200`}
              data-testid="attention-count"
            >
              <Icon name="clipboard" />
              <span className="flex-1">
                <span className="block font-medium">Count due</span>
                <span className="block text-xs">{countDueText(due)}</span>
              </span>
              <Icon name="chevron" className="size-5" />
            </Link>
          )}
        </div>
      )}
      <ViewTabs
        label="Stock view"
        current={tab}
        tabs={STOCK_TABS.map((t) => ({
          key: t.key,
          label: t.label,
          count: count[t.key],
          href: link(t.key),
        }))}
      />
      {tab === 'expiring' || tab === 'expired' ? (
        <ExpiryList
          show={tab}
          rows={dated[tab]}
          all={all}
          canDiscard={ctx.can('STOCK_ADJUSTMENTS', 'modify')}
        />
      ) : shown.length === 0 ? (
        <Empty>{tab === 'low' ? 'Nothing is running low.' : 'No items are set up here yet.'}</Empty>
      ) : (
        <div id="stock-rows" className="space-y-4">
          <ListSearch scope="stock-rows" count={shown.length} noun="items" />
          {categories.map((cat) => (
            <section key={cat} className="space-y-2" data-filter-group>
              <h2 className="text-sm font-semibold text-slate-500">{cat}</h2>
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl bg-white ring-1 ring-slate-200">
                {shown
                  .filter((r) => r.category === cat)
                  .map((r) => (
                    <li
                      key={`${storeOf(r)}:${r.item_id}`}
                      data-testid="stock-row"
                      data-sku={r.sku}
                      data-filter-row
                      data-filter-text={`${r.name} ${r.sku} ${r.category}`}
                    >
                      <Link
                        href={`/stock/items/${r.item_id}?node=${storeOf(r)}`}
                        className="flex min-h-14 items-center justify-between gap-3 px-4 py-2"
                      >
                        <ItemThumb
                          name={r.name}
                          category={r.category}
                          src={photos.get(r.item_id)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{r.name}</span>
                          {all && (
                            <span
                              className="block text-xs text-slate-500"
                              data-testid="stock-store"
                            >
                              {(r as Partial<StockRowAll>).store}
                            </span>
                          )}
                          {/* one word for it everywhere: par (ADR 054) */}
                          <span className="text-xs text-slate-500">
                            par {formatQty(r.par_level, r.base_uom)}
                            {isLow(r) && lastsText(r) ? ` · ${lastsText(r)}` : ''}
                          </span>
                        </span>
                        <span className="text-right">
                          <span className="block font-semibold tabular-nums" data-testid="on-hand">
                            {formatQty(r.on_hand, r.base_uom)}
                          </span>
                          {Number(r.on_hand) < 0 && (
                            <span
                              data-testid="below-zero"
                              className="rounded-full bg-rose-100 px-2 text-xs font-semibold text-rose-900"
                            >
                              below zero: count it
                            </span>
                          )}
                          {isLow(r) && Number(r.on_hand) >= 0 && (
                            <span
                              data-testid="running-low"
                              className="rounded-full bg-rose-50 px-2 text-xs font-semibold text-rose-800"
                            >
                              running low
                            </span>
                          )}
                        </span>
                      </Link>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {/* Running low: ask for (or order) what is low, store by store (ADR 052) */}
      {tab === 'low' && data.lowStores.length > 0 && (
        <div className="space-y-2" data-testid="order-low">
          {data.lowStores.map((st) => (
            <Link
              key={st.id}
              href={`/stock/orders/new?node=${st.id}`}
              className="flex min-h-12 items-center justify-center rounded-lg bg-brand-700 px-3 text-center font-medium text-white"
            >
              {st.main ? 'Order these' : 'Ask for these'}
              {all || data.lowStores.length > 1 ? ` · ${storeNames.get(st.id) ?? ''}` : ''}
            </Link>
          ))}
        </div>
      )}
      {/* the list first, then the store's jobs (ADR 051, 052) */}
      {actions.main.length > 0 && (
        <nav aria-label="Stock jobs" className="grid grid-cols-2 gap-2">
          {actions.main.map((a) => (
            <Link
              key={a.key}
              href={a.href}
              className="flex min-h-14 items-center gap-2 rounded-xl bg-white px-3 font-medium shadow-sm ring-1 ring-slate-200"
            >
              <Icon name={a.icon} className="size-5 text-brand-700" />
              {a.label}
            </Link>
          ))}
        </nav>
      )}
      {actions.more.length > 0 && (
        <div className="flex flex-wrap justify-center gap-x-6" data-testid="stock-more">
          {actions.more.map((a) => (
            <Link
              key={a.key}
              href={a.href}
              className="flex min-h-11 items-center text-sm font-medium text-brand-700 underline"
            >
              {a.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
