import Link from 'next/link';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen, processLabel } from '@/lib/format';
import { SUPPLY_PROGRESS } from '@/lib/inventory';

// Things I asked for (ADR 052): every request opens; a supply request says where the order is
// and what is in it, in the department's words, never an estimate in ₹.

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
    case 'hr.leave_request':
      return `/leave/${r.subject_id}`;
    case 'hr.shift_swap':
      return `/roster/swaps/${r.subject_id}`;
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
      /** a supply request: the order's progress and items (ADR 049, 052) */
      progress: string | null;
      items: string | null;
    }>`select r.id, r.process_type, r.state, r.current_step, r.amount, r.created_at,
              r.subject_type, r.subject_id, r.delivery_node_id,
              exists (select 1 from wf.step_instance s
                       where s.request_id = r.id and s.top_of_chain
                         and s.state = 'approved') as top_of_chain,
              po.progress,
              (select string_agg(i.name, ', ' order by i.name)
                 from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
                where pl.po_id = po.id) as items
         from wf.request r
         left join inv.purchase_order_summary po
                on r.subject_type = 'inv.purchase_order' and po.id = r.subject_id
        where r.initiator_id = core.current_user_id()
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
          {rows.map((r) => {
            const href = subjectHref(r);
            const supply = r.progress !== null;
            const [state, style] = supply
              ? (SUPPLY_PROGRESS[r.progress!] ?? [r.progress!, ''])
              : [r.state.replace(/_/g, ' '), STATE_STYLE[r.state] ?? ''];
            const body = (
              <>
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {supply ? 'Supply request' : processLabel(r.process_type)}
                  </span>
                  <span
                    data-testid="request-state"
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}
                  >
                    {state}
                  </span>
                </span>
                {r.items && (
                  <span className="mt-1 block truncate text-sm text-slate-700">{r.items}</span>
                )}
                {r.top_of_chain && !supply && (
                  <span className="block text-sm text-slate-600" data-testid="top-of-chain">
                    Approved automatically: top of chain, no higher approver.
                  </span>
                )}
                <span className="block text-sm text-slate-600">
                  {!supply && r.current_step
                    ? `waiting on ${r.current_step.replace(/_/g, ' ')} · `
                    : ''}
                  {formatWhen(r.created_at)}
                </span>
              </>
            );
            const card = 'block rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200';
            return (
              <li key={r.id} data-testid="request-item" data-request-id={r.id}>
                {href ? (
                  <Link href={href} className={card}>
                    {body}
                  </Link>
                ) : (
                  <div className={card}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
