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
import { ExpiryBanner } from '@/components/expiry-banner';
import { ItemThumb } from '@/components/item-thumb';
import { splitExpiry } from '@/lib/expiry';
import { isLow, lastsText } from '@/lib/low-stock';
import { itemPhotoUrls } from '@/lib/photos';
import {
  expiryList,
  formatQty,
  param,
  stockList,
  supplyContext,
  type SearchParams,
} from '@/lib/inventory';

export default async function StockPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'stock');
  if (!ctx.can('STOCK_LEVELS') || !ctx.node) return <NoSupplyAccess />;
  // "Running low" (UX-6): runs out within three days at the recent rate (lib/low-stock.ts)
  const sp = await searchParams;
  const lowOnly = param(sp, 'low') === '1' || param(sp, 'below') === '1';
  const user = await requireUser();
  const node = ctx.node;
  const adjust = ctx.can('STOCK_ADJUSTMENTS', 'modify') && !node.derived;
  const data = await withUser(user.id, async (tx) => {
    const rows = await stockList(tx, node.id);
    const dated = splitExpiry(await expiryList(tx), node.id);
    // stock on its way here (sent, not yet received); RLS shows only transfers they may see
    const transit = ctx.can('TRANSFERS')
      ? Number(
          (
            await sql<{ n: string }>`
              select count(*) as n from inv.transfer_summary
               where to_node_id = ${node.id}::uuid and progress = 'in_transit'`.execute(tx)
          ).rows[0]!.n,
        )
      : 0;
    // the last submitted count here, for "count due" (count_due_days, ADR 035)
    const last = adjust
      ? ((
          await sql<{ at: Date | null }>`
            select max(submitted_at) as at from inv.stock_count
             where delivery_node_id = ${node.id}::uuid and status = 'submitted'`.execute(tx)
        ).rows[0]?.at ?? null)
      : null;
    return { rows, dated, transit, last, settings: await companySettings(tx) };
  });
  const { rows, dated } = data;
  const due = adjust ? countDue(data.last, data.settings.count_due_days) : null;
  const photos = await itemPhotoUrls(rows);
  const low = rows.filter((r) => isLow(r));
  const shown = lowOnly ? low : rows;
  const q = `node=${node.id}`;
  const actions = hubActions(
    {
      adjust,
      order: ctx.can('PURCHASE_ORDERS', 'modify') && !node.derived,
      request: ctx.can('TRANSFERS', 'modify') && !node.derived && node.holds_stock,
    },
    q,
  );
  const attention = 'flex min-h-14 items-center gap-3 rounded-xl px-4 py-2 ring-1';
  const categories = [...new Set(shown.map((r) => r.category))];
  return (
    <div className="space-y-4">
      <PollRefresh />
      <SupplyHeader ctx={ctx} active="/stock" title="Stock" />
      {/* what needs doing first (UX-4): running low, expiry (INV-12), on its way, count due */}
      <div className="space-y-2" data-testid="stock-attention">
        {low.length > 0 && !lowOnly && (
          <Link
            href={`/stock?${q}&low=1`}
            className={`${attention} bg-rose-50 text-rose-900 ring-rose-200`}
            data-testid="attention-low"
          >
            <Icon name="down" />
            <span className="flex-1 font-medium">Running low</span>
            <span className="text-lg font-semibold tabular-nums">{low.length}</span>
            <Icon name="chevron" className="size-5" />
          </Link>
        )}
        {(['expiring', 'expired'] as const)
          .filter((show) => dated[show].length > 0)
          .map((show) => (
            <ExpiryBanner key={show} show={show} n={dated[show].length} q={`${q}&`} />
          ))}
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
      {actions.length > 0 && (
        <nav aria-label="Stock jobs" className="grid grid-cols-2 gap-2">
          {actions.map((a) => (
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
      <div className="flex gap-2">
        <Link
          href={`/stock?${q}`}
          aria-current={!lowOnly ? 'true' : undefined}
          className={`flex min-h-11 flex-1 items-center justify-center rounded-lg text-sm ${!lowOnly ? 'bg-slate-200 font-semibold' : 'ring-1 ring-slate-300'}`}
        >
          All ({rows.length})
        </Link>
        <Link
          href={`/stock?${q}&low=1`}
          aria-current={lowOnly ? 'true' : undefined}
          className={`flex min-h-11 flex-1 items-center justify-center rounded-lg text-sm ${lowOnly ? 'bg-slate-200 font-semibold' : 'ring-1 ring-slate-300'}`}
        >
          Running low ({low.length})
        </Link>
      </div>
      {shown.length === 0 ? (
        <Empty>{lowOnly ? 'Nothing is running low.' : 'No items are set up here yet.'}</Empty>
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
                      key={r.item_id}
                      data-testid="stock-row"
                      data-sku={r.sku}
                      data-filter-row
                      data-filter-text={`${r.name} ${r.sku} ${r.category}`}
                    >
                      <Link
                        href={`/stock/items/${r.item_id}?${q}`}
                        className="flex min-h-14 items-center justify-between gap-3 px-4 py-2"
                      >
                        <ItemThumb category={r.category} src={photos.get(r.item_id)} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{r.name}</span>
                          {/* plain words (UX-6): what the store keeps, not "par" */}
                          <span className="text-xs text-slate-500">
                            keep at {formatQty(r.par_level, r.base_uom)}
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
    </div>
  );
}
