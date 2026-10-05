import Link from 'next/link';
import { formatWhen } from '@/lib/format';
import type { DeskOrder } from '@/lib/inventory';

/**
 * The order desk's two jobs as lists (ADR 049): requests to order and orders to receive.
 * They close themselves: ordering takes a request out of the first, receiving everything
 * out of the second.
 */
export function DeskOrders({ rows }: { rows: DeskOrder[] }) {
  if (rows.length === 0) return null;
  const parts: [DeskOrder['stage'], string, string][] = [
    ['to_order', 'To order', 'Place order'],
    ['to_receive', 'To receive', 'Receive'],
  ];
  return (
    <>
      {parts.map(([stage, title, action]) => {
        const list = rows.filter((r) => r.stage === stage);
        if (list.length === 0) return null;
        return (
          <section key={stage} className="space-y-2" aria-label={title}>
            <h2 className="text-sm font-semibold text-slate-500">{title}</h2>
            <ul data-testid={`desk-${stage}`} className="space-y-2">
              {list.map((r) => (
                <li key={r.po_id} data-testid="desk-order">
                  <Link
                    href={`/stock/orders/${r.po_id}?node=${r.store_id}`}
                    className="flex min-h-14 items-center justify-between gap-2 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {stage === 'to_order'
                          ? `Supplies for ${r.store}`
                          : `${r.supplier ?? 'Supplies'} for ${r.store}`}
                      </span>
                      <span className="block truncate text-xs text-slate-500">
                        {r.items}
                        {stage === 'to_order'
                          ? ` · asked by ${r.requested_by ?? 'someone'}, ${formatWhen(r.requested_at)}`
                          : r.expected_on
                            ? ` · due ${new Date(r.expected_on).toISOString().slice(0, 10)}`
                            : ''}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm underline">{action}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
