import Link from 'next/link';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { isDevAuthEnabled } from '@/lib/dev-auth';
import { formatMoney, formatWhen, processLabel } from '@/lib/format';

const STATE_STYLE: Record<string, string> = {
  in_approval: 'bg-amber-100 text-amber-900',
  approved: 'bg-emerald-100 text-emerald-900',
  executing: 'bg-emerald-100 text-emerald-900',
  completed: 'bg-emerald-100 text-emerald-900',
  rejected: 'bg-rose-100 text-rose-900',
  cancelled: 'bg-slate-200 text-slate-700',
  failed: 'bg-rose-100 text-rose-900',
};

export default async function RequestsPage() {
  const user = await requireUser();
  // RLS on wf.request decides what is visible; this page lists the user's own requests.
  const rows = await withUser(user.id, async (tx) => {
    const r = await sql<{
      id: string;
      process_type: string;
      state: string;
      current_step: string | null;
      amount: string | null;
      created_at: Date;
    }>`select id, process_type, state, current_step, amount, created_at
         from wf.request where initiator_id = core.current_user_id()
        order by created_at desc limit 50`.execute(tx);
    return r.rows;
  });
  return (
    <div className="space-y-4">
      <PollRefresh />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">My requests</h1>
        {isDevAuthEnabled() && (
          <Link
            href="/requests/new"
            className="min-h-11 rounded-lg bg-slate-900 px-3 py-2.5 text-sm font-medium text-white"
          >
            New test request
          </Link>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
          No requests yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li
              key={r.id}
              data-testid="request-item"
              data-request-id={r.id}
              className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-medium">{processLabel(r.process_type)}</p>
                <span
                  data-testid="request-state"
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATE_STYLE[r.state] ?? ''}`}
                >
                  {r.state.replace(/_/g, ' ')}
                </span>
              </div>
              <p className="text-sm text-slate-600">
                {formatMoney(r.amount) ?? ''}{' '}
                {r.current_step ? `· waiting on ${r.current_step.replace(/_/g, ' ')}` : ''} ·{' '}
                {formatWhen(r.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
