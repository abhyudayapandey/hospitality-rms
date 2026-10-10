import { ItemThumb } from '@/components/item-thumb';
import { formatMoney } from '@/lib/format';

/**
 * What was used from a minibar (ADR 104): each item's photo, its name and a big ×N; the price
 * only where it is billed.
 */
export function UsedLines({
  used,
  prices = false,
  testId,
}: {
  used: readonly { item: string; qty: string; price?: string | undefined }[];
  prices?: boolean;
  testId?: string;
}) {
  return (
    <ul className="divide-y divide-slate-100" data-testid={testId}>
      {used.map((u) => (
        <li key={u.item} className="flex items-center gap-3 py-2" data-testid="minibar-line">
          <ItemThumb name={u.item} size="size-12" />
          <span className="min-w-0 flex-1 text-sm">{u.item}</span>
          <span className="shrink-0 text-2xl font-bold tabular-nums" data-testid="minibar-qty">
            ×{Number(u.qty)}
          </span>
          {prices && u.price !== undefined && (
            <span className="w-20 shrink-0 text-right text-sm tabular-nums">
              {formatMoney(Number(u.qty) * Number(u.price))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
