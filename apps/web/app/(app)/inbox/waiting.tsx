import Link from 'next/link';
import { DeskOrders } from '@/components/desk-orders';
import { formatWhen } from '@/lib/format';
import type { InboxEntry } from '@/lib/inbox';
import type { DeskOrder } from '@/lib/inventory';
import type { ToAssign } from '@/lib/tasks';
import { InboxItem } from './inbox-item';

/**
 * What waits for the person's yes or hand, at the top of their To do list (ADR 144): the
 * order desk's orders, what to assign, then approvals. Their tasks follow it on the same list.
 */
export function WaitingForYou({
  rows,
  assign,
  desk,
}: {
  rows: InboxEntry[];
  assign: ToAssign[];
  desk: DeskOrder[];
}) {
  return (
    <>
      <DeskOrders rows={desk} />
      {assign.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">To assign</h2>
          <ul data-testid="to-assign" className="space-y-2">
            {assign.map((a) => (
              <li key={a.id}>
                <Link
                  href={a.kind === 'expiry' ? `/tasks/${a.id}` : `/tasks/maintenance/${a.id}`}
                  className="flex min-h-14 items-center justify-between gap-2 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{a.title}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {a.kind === 'expiry' ? 'Expired batch' : 'Maintenance'} · {a.place_name}
                      {a.reported_by && ` · from ${a.reported_by}`} · {formatWhen(a.reported_at)}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm underline">Assign</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {rows.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">To approve</h2>
          <ul className="space-y-3">
            {rows.map((r) => (
              <InboxItem key={r.requestId} entry={r} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
