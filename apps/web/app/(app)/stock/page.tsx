import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatQty, param, stockList, supplyContext, type SearchParams } from '@/lib/inventory';

export default async function StockPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams);
  if (!ctx.can('STOCK_LEVELS') || !ctx.node) return <NoSupplyAccess />;
  const belowOnly = param(await searchParams, 'below') === '1';
  const user = await requireUser();
  const rows = await withUser(user.id, (tx) => stockList(tx, ctx.node!.id));
  const shown = belowOnly ? rows.filter((r) => r.below_par) : rows;
  const q = `node=${ctx.node.id}`;
  const categories = [...new Set(shown.map((r) => r.category))];
  return (
    <div className="space-y-4">
      <PollRefresh />
      <SupplyHeader ctx={ctx} active="/stock" title="Stock" />
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
                        {r.below_par && (
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
