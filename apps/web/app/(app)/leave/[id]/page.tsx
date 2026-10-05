import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { formatDay, formatSpan } from '@/lib/dates';
import { sql, withUser } from '@/lib/db';
import { isUuid } from '@/lib/inventory';
import { balances } from '@/lib/people';
import { RequestDecision } from '@/components/request-decision';
import { jobTitles } from '@/lib/job-titles';

// A leave request: the worker, dates and days, their balance for that type, and the
// assigned shifts that approval would drop, all shown before the approver decides.
export default async function LeaveRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return <Empty>Not found.</Empty>;
  const user = await requireUser();
  const title = await withUser(user.id, jobTitles);
  const data = await withUser(user.id, async (tx) => {
    const l = await sql<{
      id: string;
      worker_id: string;
      worker_name: string | null;
      type_name: string;
      leave_type_id: string;
      from_date: string;
      to_date: string;
      days: string;
      reason: string | null;
      status: string;
      wf_request_id: string | null;
      pending_for_me: boolean;
      mine: boolean;
      tz: string | null;
    }>`
      select l.id, l.worker_id, d.display_name as worker_name, t.name as type_name, l.leave_type_id,
             l.from_date::text, l.to_date::text, l.days, l.reason, l.status, l.wf_request_id,
             exists (select 1 from wf.my_inbox() i where i.request_id = l.wf_request_id) as pending_for_me,
             l.owner_user_id = core.current_user_id() as mine,
             (select timezone from core.nodes('org') n where n.id = l.org_node_id) as tz
        from hr.leave_request l
        join hr.leave_type t on t.id = l.leave_type_id
        left join hr.worker_directory d on d.worker_id = l.worker_id
       where l.id = ${id}::uuid`.execute(tx);
    const leave = l.rows[0];
    if (!leave) return null;
    const year = Number(leave.from_date.slice(0, 4));
    const bal = (await balances(tx, leave.worker_id, year)).find(
      (b) => b.leave_type_id === leave.leave_type_id,
    );
    const drops =
      leave.status === 'submitted'
        ? (
            await sql<{
              assignment_id: string;
              local_date: string;
              start_at: Date;
              end_at: Date;
              role_code: string;
            }>`
              select assignment_id, local_date::text as local_date, start_at, end_at, role_code
                from hr.leave_conflicts(${id}::uuid)`.execute(tx)
          ).rows
        : [];
    return { leave, bal, drops };
  });
  if (!data) return <Empty>Leave request not found.</Empty>;
  const { leave, bal, drops } = data;
  const tz = leave.tz ?? 'Asia/Kolkata';
  return (
    <div className="space-y-4">
      <Link href={leave.mine ? '/leave' : '/inbox'} className="text-sm text-slate-600">
        ← {leave.mine ? 'Leave' : 'To do list'}
      </Link>
      <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <h1 className="text-lg font-semibold">
          {leave.type_name}
          {leave.worker_name && !leave.mine ? ` · ${leave.worker_name}` : ''}
        </h1>
        <p className="text-sm text-slate-600">
          {formatDay(leave.from_date)}
          {leave.to_date !== leave.from_date ? ` – ${formatDay(leave.to_date)}` : ''} ·{' '}
          {Number(leave.days)} calendar day{Number(leave.days) === 1 ? '' : 's'}
        </p>
        {leave.reason && <p className="mt-1 text-sm">“{leave.reason}”</p>}
        <p className="mt-1 text-sm text-slate-600">Status: {leave.status}</p>
      </div>
      {bal && bal.available_days !== null && (
        <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200" data-testid="leave-balance">
          <h2 className="text-sm font-semibold text-slate-700">
            {bal.name} balance {bal.year}
          </h2>
          <p className="text-sm tabular-nums">
            {Number(bal.entitled_days)} entitled · {Number(bal.used_days)} used ·{' '}
            {Number(bal.pending_days)} pending (incl. this) · {Number(bal.available_days)} left
            after pending
          </p>
        </div>
      )}
      {leave.status === 'submitted' && (
        <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200" data-testid="leave-drops">
          <h2 className="text-sm font-semibold text-slate-700">
            {drops.length === 0
              ? 'No rostered shifts in these dates.'
              : `Approving removes ${drops.length === 1 ? 'this shift' : `these ${drops.length} shifts`} from the roster:`}
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {drops.map((d) => (
              <li key={d.assignment_id} className="tabular-nums">
                {formatDay(d.local_date)} · {formatSpan(d.start_at, d.end_at, tz)} ·{' '}
                {title(d.role_code)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {leave.pending_for_me && leave.wf_request_id && (
        <RequestDecision requestId={leave.wf_request_id} back="/inbox" />
      )}
    </div>
  );
}
