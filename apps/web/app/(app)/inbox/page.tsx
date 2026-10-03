import Link from 'next/link';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { inboxEntries } from '@/lib/inbox';
import { toAssign } from '@/lib/tasks';
import { InboxItem } from './inbox-item';

export default async function InboxPage() {
  const user = await requireUser();
  const { rows, assign } = await withUser(user.id, async (tx) => ({
    rows: await inboxEntries(tx),
    assign: await toAssign(tx),
  }));
  return (
    <div className="space-y-4">
      <PollRefresh />
      <h1 className="text-xl font-semibold">Approvals</h1>
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
      {rows.length === 0 && assign.length === 0 ? (
        <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
          Nothing is waiting for you.
        </p>
      ) : rows.length === 0 ? null : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <InboxItem key={r.requestId} entry={r} />
          ))}
        </ul>
      )}
    </div>
  );
}
