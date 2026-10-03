import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
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
  const [rows, dated] = await withUser(
    user.id,
    async (tx) =>
      [await stockList(tx, ctx.node!.id), splitExpiry(await expiryList(tx), ctx.node!.id)] as const,
  );
  const photos = await itemPhotoUrls(rows);
  const low = rows.filter((r) => isLow(r));
  const shown = lowOnly ? low : rows;
  const q = `node=${ctx.node.id}`;
  const categories = [...new Set(shown.map((r) => r.category))];
  return (
    <div className="space-y-4">
      <PollRefresh />
      <SupplyHeader ctx={ctx} active="/stock" title="Stock" />
      {/* INV-12: what to use first, and what has to go */}
      {(['expiring', 'expired'] as const)
        .filter((show) => dated[show].length > 0)
        .map((show) => (
          <ExpiryBanner key={show} show={show} n={dated[show].length} q={`${q}&`} />
        ))}
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
        categories.map((cat) => (
          <section key={cat} className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-500">{cat}</h2>
            <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl bg-white ring-1 ring-slate-200">
              {shown
                .filter((r) => r.category === cat)
                .map((r) => (
                  <li key={r.item_id} data-testid="stock-row" data-sku={r.sku}>
                    <Link
                      href={`/stock/items/${r.item_id}?${q}`}
                      className="flex min-h-14 items-center justify-between gap-3 px-4 py-2"
                    >
                      <ItemThumb category={r.category} src={photos.get(r.item_id)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{r.name}</span>
                        {/* plain words (UX-6): what the store keeps, not "par" */}
                        <span className="text-xs text-slate-500">
                          keep {formatQty(r.par_level, r.base_uom)}
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
        ))
      )}
    </div>
  );
}
