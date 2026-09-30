import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { formatDay, formatSpan } from '@/lib/dates';
import { sql, withUser } from '@/lib/db';
import { isUuid } from '@/lib/inventory';
import { SwapDecision } from './swap-decision';

// Manager review of a shift swap. Approval goes through hr.approve_swap, which re-runs the
// rostering rules for the colleague and shows the broken rule instead of approving.
export default async function SwapReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return <Empty>Not found.</Empty>;
  const user = await requireUser();
  const s = await withUser(user.id, async (tx) => {
    const r = await sql<{
      id: string;
      status: string;
      note: string | null;
      local_date: string;
      start_at: Date;
      end_at: Date;
      role_code: string;
      from_name: string | null;
      to_name: string | null;
      wf_request_id: string | null;
      pending_for_me: boolean;
      tz: string | null;
    }>`
      select sw.id, sw.status, sw.note, s.local_date::text as local_date, s.start_at, s.end_at,
             s.role_code, f.display_name as from_name, t.display_name as to_name, sw.wf_request_id,
             exists (select 1 from wf.my_inbox() i where i.request_id = sw.wf_request_id) as pending_for_me,
             (select timezone from core.nodes('org') n where n.id = sw.org_node_id) as tz
        from hr.shift_swap sw
        join hr.shift s on s.id = sw.shift_id
        left join hr.worker_directory f on f.worker_id = sw.from_worker_id
        left join hr.worker_directory t on t.worker_id = sw.to_worker_id
       where sw.id = ${id}::uuid`.execute(tx);
    return r.rows[0] ?? null;
  });
  if (!s) return <Empty>Swap not found.</Empty>;
  return (
    <div className="space-y-4">
      <Link href="/inbox" className="text-sm text-slate-600">
        ← Inbox
      </Link>
      <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <h1 className="text-lg font-semibold">Shift swap</h1>
        <p className="text-sm text-slate-600 tabular-nums">
          {formatDay(s.local_date)} · {formatSpan(s.start_at, s.end_at, s.tz ?? 'Asia/Kolkata')} ·{' '}
          {s.role_code.toLowerCase()}
        </p>
        <p className="mt-2" data-testid="swap-parties">
          {s.from_name ?? 'Worker'} → {s.to_name ?? 'Worker'}
        </p>
        {s.note && <p className="mt-1 text-sm">“{s.note}”</p>}
        <p className="mt-1 text-sm text-slate-600">Status: {s.status}</p>
      </div>
      {s.pending_for_me && s.wf_request_id && (
        <SwapDecision swap={s.id} requestId={s.wf_request_id} />
      )}
    </div>
  );
}
