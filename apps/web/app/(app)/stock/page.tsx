import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { EXPIRY_TITLE, splitExpiry, type ExpiryShow } from '@/lib/expiry';
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
  const belowOnly = param(await searchParams, 'below') === '1';
  const user = await requireUser();
  const [rows, dated] = await withUser(
    user.id,
    async (tx) =>
      [await stockList(tx, ctx.node!.id), splitExpiry(await expiryList(tx), ctx.node!.id)] as const,
  );
  const shown = belowOnly ? rows.filter((r) => r.below_par) : rows;
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
          <ExpiryBanner key={show} show={show} n={dated[show].length} q={q} />
        ))}
      <div className="flex gap-2">
        <Link
          href={`/stock?${q}`}
          aria-current={!belowOnly ? 'true' : undefined}
          className={`flex min-h-11 flex-1 items-center justify-center rounded-lg text-sm ${!belowOnly ? 'bg-slate-200 font-semibold' : 'ring-1 ring-slate-300'}`}
        >
          All ({rows.length})
        </Link>
        <Link
          href={`/stock?${q}&below=1`}
          aria-current={belowOnly ? 'true' : undefined}
          className={`flex min-h-11 flex-1 items-center justify-center rounded-lg text-sm ${belowOnly ? 'bg-slate-200 font-semibold' : 'ring-1 ring-slate-300'}`}
        >
          Below par ({rows.filter((r) => r.below_par).length})
        </Link>
      </div>
      {shown.length === 0 ? (
        <Empty>{belowOnly ? 'Nothing is below par.' : 'No items are set up here yet.'}</Empty>
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
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{r.name}</span>
                        <span className="text-xs text-slate-500">
                          par {formatQty(r.par_level, r.base_uom)}
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
                        {r.below_par && Number(r.on_hand) >= 0 && (
                          <span className="rounded-full bg-amber-100 px-2 text-xs font-semibold text-amber-900">
                            below par
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

function ExpiryBanner({ show, n, q }: { show: ExpiryShow; n: number; q: string }) {
  const tone =
    show === 'expired'
      ? 'bg-rose-50 text-rose-900 ring-rose-200'
      : 'bg-amber-50 text-amber-900 ring-amber-200';
  return (
    <Link
      href={`/stock/expiry?${q}&show=${show}`}
      className={`flex min-h-14 items-center justify-between gap-3 rounded-xl px-4 py-2 ring-1 ${tone}`}
      data-testid={`banner-${show}`}
    >
      <span className="font-medium">{EXPIRY_TITLE[show]}</span>
      <span className="flex items-center gap-2">
        <span className="text-lg font-semibold tabular-nums">{n}</span>
        <span aria-hidden="true">›</span>
      </span>
    </Link>
  );
}
