import Link from 'next/link';
import { formatWhen } from '@/lib/format';
import type { InboxEntry } from '@/lib/inbox';
import type { toAssign } from '@/lib/tasks';
import { DeskOrders } from '@/components/desk-orders';
import type { deskOrders } from '@/lib/inventory';
import { InboxItem } from './inbox-item';

/**
 * What waits for the person's yes or hand (ADR 147), at the top of the one To do list: the
 * order desk's orders, what to assign, then approvals. Their own tasks follow it on the page.
 */
export function WaitingForYou({
  rows,
  assign,
  desk,
  tz,
}: {
  rows: InboxEntry[];
  assign: Awaited<ReturnType<typeof toAssign>>;
  desk: Awaited<ReturnType<typeof deskOrders>>;
  tz: string;
}) {
  return (
    <div className="space-y-4">
      <DeskOrders rows={desk} tz={tz} />
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
                      {a.reported_by && ` · from ${a.reported_by}`} ·{' '}
                      {formatWhen(a.reported_at, tz)}
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
        <ul className="space-y-3">
          {rows.map((r) => (
            <InboxItem key={r.requestId} entry={r} />
          ))}
        </ul>
      )}
    </div>
  );
}
