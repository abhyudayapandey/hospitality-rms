import Link from 'next/link';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
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

function subjectHref(r: {
  subject_type: string;
  subject_id: string;
  delivery_node_id: string | null;
}): string | null {
  const q = r.delivery_node_id ? `?node=${r.delivery_node_id}` : '';
  switch (r.subject_type) {
    case 'inv.purchase_order':
      return `/stock/orders/${r.subject_id}${q}`;
    case 'inv.transfer':
      return `/stock/transfers/${r.subject_id}${q}`;
    case 'inv.stock_adjustment':
      return `/stock/adjustments/${r.subject_id}`;
    default:
      return null;
  }
}

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
      subject_type: string;
      subject_id: string;
      delivery_node_id: string | null;
      top_of_chain: boolean;
    }>`select r.id, r.process_type, r.state, r.current_step, r.amount, r.created_at,
              r.subject_type, r.subject_id, r.delivery_node_id,
              exists (select 1 from wf.step_instance s
                       where s.request_id = r.id and s.top_of_chain
                         and s.state = 'approved') as top_of_chain
         from wf.request r where r.initiator_id = core.current_user_id()
        order by r.created_at desc limit 50`.execute(tx);
    return r.rows;
  });
  return (
    <div className="space-y-4">
      <PollRefresh />
      <h1 className="text-xl font-semibold">Things I asked for</h1>
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
              {subjectHref(r) && (
                <Link href={subjectHref(r)!} className="text-sm text-slate-700 underline">
                  Open
                </Link>
              )}
              {r.top_of_chain && (
                <p className="text-sm text-slate-600" data-testid="top-of-chain">
                  Approved automatically: top of chain, no higher approver.
                </p>
              )}
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
