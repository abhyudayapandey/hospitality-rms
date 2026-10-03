import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { EXPIRY_TITLE, expiryShow, splitExpiry } from '@/lib/expiry';
import { formatWhen } from '@/lib/format';
import { expiryList, formatQty, param, supplyContext, type SearchParams } from '@/lib/inventory';

// The lists the Stock screen's banners open (INV-12, ADR 033): batches expiring within 3
// days, soonest first, and expired batches, most recently expired first. Expired stock is
// thrown away through Wastage, which tells the GM (NT-2).
export default async function ExpiryPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'stock');
  if (!ctx.can('STOCK_LEVELS') || !ctx.node) return <NoSupplyAccess />;
  const show = expiryShow(param(await searchParams, 'show'));
  const user = await requireUser();
  const lists = await withUser(user.id, async (tx) =>
    splitExpiry(await expiryList(tx), ctx.node!.id),
  );
  const rows = lists[show];
  const q = `node=${ctx.node.id}`;
  const canDiscard = ctx.can('STOCK_ADJUSTMENTS', 'modify');
  return (
    <div className="space-y-4">
      <SupplyHeader ctx={ctx} active="/stock" title="Stock" />
      <nav aria-label="Expiry" className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
        {(['expiring', 'expired'] as const).map((s) => (
          <Link
            key={s}
            href={`/stock/expiry?${q}&show=${s}`}
            aria-current={s === show ? 'page' : undefined}
            className={`flex min-h-11 items-center justify-center rounded-md px-2 text-center text-sm ${
              s === show ? 'bg-white font-semibold shadow-sm' : 'text-slate-600'
            }`}
          >
            {s === 'expiring' ? 'Within 3 days' : 'Expired'} ({lists[s].length})
          </Link>
        ))}
      </nav>
      <h2 className="font-semibold">{EXPIRY_TITLE[show]}</h2>
      {rows.length === 0 ? (
        <Empty>
          {show === 'expired' ? 'Nothing here has expired.' : 'Nothing expires in the next 3 days.'}
        </Empty>
      ) : (
        <ul
          className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
          data-testid={`expiry-${show}`}
        >
          {rows.map((b) => (
            <li
              key={`${b.item_id}:${b.batch_no}:${b.expires_at}`}
              className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
              data-testid="expiry-row"
              data-sku={b.sku}
            >
              <span className="min-w-0">
                <span className="block font-medium">{b.name}</span>
                <span className="block text-xs text-slate-500">
                  {formatQty(b.remaining, b.unit)} left
                  {b.batch_no ? ` · batch ${b.batch_no}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span
                  className={`block text-xs ${show === 'expired' ? 'text-rose-800' : 'text-amber-800'}`}
                >
                  {show === 'expired' ? 'Expired' : 'Use by'}
                </span>
                <span className="block font-medium tabular-nums" data-testid="use-by">
                  {formatWhen(b.expires_at)}
                </span>
                {show === 'expired' && canDiscard && (
                  <Link
                    href={`/stock/wastage?${q}&item=${b.item_id}&qty=${Number(b.remaining)}&reason=expired`}
                    className="mt-1 inline-flex min-h-11 items-center text-sm font-medium underline"
                  >
                    Throw away
                  </Link>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
