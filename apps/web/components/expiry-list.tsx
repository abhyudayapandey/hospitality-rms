import Link from 'next/link';
import { Empty } from '@/components/messages';
import { businessDate, formatDay } from '@/lib/dates';
import { EXPIRY_TITLE, type ExpiryBatch, type ExpiryShow } from '@/lib/expiry';
import { formatQty } from '@/lib/inventory';
import { inputQty } from '@/lib/qty';
import { ItemThumb } from '@/components/item-thumb';
import { PackButtons } from '@/components/pack-buttons';

/**
 * The Expiring and Expired tabs of the Stock screen (INV-12, ADR 033): batches expiring
 * within 3 days, soonest first, or expired, most recent first. With "All stores" each line
 * names its store. Expired stock is thrown away through Wastage, which tells the GM (NT-2); an
 * expired opened pack (ADR 093) is thrown away here, by the same rules.
 */
export function ExpiryList({
  show,
  rows,
  all,
  canDiscard,
}: {
  show: ExpiryShow;
  rows: ExpiryBatch[];
  all: boolean;
  canDiscard: boolean;
}) {
  return (
    <div className="space-y-2">
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
              key={b.pack_id ?? `${b.store_id}:${b.item_id}:${b.batch_no}:${b.expires_at}`}
              className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
              data-testid="expiry-row"
              data-sku={b.sku}
            >
              <ItemThumb name={b.name} size="size-10" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{b.name}</span>
                {all && (
                  <span className="block text-xs text-slate-500" data-testid="expiry-store">
                    {b.store}
                  </span>
                )}
                <span className="block text-xs text-slate-500">
                  {formatQty(b.remaining, b.unit)} left
                  {b.batch_no ? ` · batch ${b.batch_no}` : ''}
                  {b.pack_id ? ' · opened pack' : ''}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span
                  className={`block text-xs ${show === 'expired' ? 'text-rose-800' : 'text-amber-800'}`}
                >
                  {show === 'expired' ? 'Expired' : 'Use by'}
                </span>
                <span className="block font-medium tabular-nums" data-testid="use-by">
                  {formatDay(businessDate(b.expires_at))}
                </span>
                {show === 'expired' && canDiscard && b.pack_id && (
                  <PackButtons pack={b.pack_id} expired />
                )}
                {show === 'expired' && canDiscard && !b.pack_id && (
                  <Link
                    href={`/stock/wastage?node=${b.store_id}&item=${b.item_id}&qty=${inputQty(b.remaining)}&reason=expired`}
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
