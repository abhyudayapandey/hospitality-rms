import Link from 'next/link';
import { ERROR_MESSAGES, messageFor, type ErrorCode } from '@outlet-ops/domain';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { formatDay, formatSpan } from '@/lib/dates';
import { sql, withUser } from '@/lib/db';
import { isUuid } from '@/lib/inventory';
import { candidates, swapChecks } from '@/lib/people';
import { warningPhrase, warningSentence } from '@/lib/roster-warnings';
import { ReassignButton, SwapDecision } from './swap-decision';
import { jobTitles } from '@/lib/job-titles';

const STATUS: Record<string, string> = {
  submitted: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Not approved',
  cancelled: 'Cancelled',
  reassigned: 'Assigned to someone else',
};

// Manager review of a shift swap (ADR 019). Rest and weekly hours are warnings: they are
// shown, and the button reads "Approve anyway". Any other rule stops approval. An approver
// who can change the roster here can instead give the shift to someone else, straight onto
// their roster.
export default async function SwapReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return <Empty>Not found.</Empty>;
  const user = await requireUser();
  const title = await withUser(user.id, jobTitles);
  const data = await withUser(user.id, async (tx) => {
    const r = await sql<{
      id: string;
      status: string;
      note: string | null;
      shift_id: string;
      from_worker_id: string;
      to_worker_id: string;
      local_date: string;
      start_at: Date;
      end_at: Date;
      role_code: string;
      from_name: string | null;
      to_name: string | null;
      reassigned_name: string | null;
      wf_request_id: string | null;
      pending_for_me: boolean;
      can_roster: boolean;
      tz: string | null;
    }>`
      select sw.id, sw.status, sw.note, s.id as shift_id, sw.from_worker_id, sw.to_worker_id,
             s.local_date::text as local_date, s.start_at, s.end_at, s.role_code,
             f.display_name as from_name, t.display_name as to_name,
             r.display_name as reassigned_name, sw.wf_request_id,
             exists (select 1 from wf.my_inbox() i where i.request_id = sw.wf_request_id) as pending_for_me,
             core.can('ROSTER', 'modify', sw.org_node_id, null, null) as can_roster,
             (select timezone from core.nodes('org') n where n.id = sw.org_node_id) as tz
        from hr.shift_swap sw
        join hr.shift s on s.id = sw.shift_id
        left join hr.worker_directory f on f.worker_id = sw.from_worker_id
        left join hr.worker_directory t on t.worker_id = sw.to_worker_id
        left join hr.worker_directory r on r.worker_id = sw.reassigned_worker_id
       where sw.id = ${id}::uuid`.execute(tx);
    const s = r.rows[0];
    if (!s) return null;
    const open = s.pending_for_me && s.status === 'submitted';
    const checks = open ? await swapChecks(tx, s.id) : [];
    const others =
      open && s.can_roster
        ? (await candidates(tx, s.shift_id)).filter(
            (c) =>
              !c.violation && c.worker_id !== s.to_worker_id && c.worker_id !== s.from_worker_id,
          )
        : [];
    return { s, open, checks, others };
  });
  if (!data) return <Empty>Swap not found.</Empty>;
  const { s, open, checks, others } = data;
  const to = s.to_name ?? 'Your colleague';
  const warnings = checks.filter((c) => c.warning);
  const blockers = checks.filter((c) => !c.warning);
  const reason = (code: string) =>
    code in ERROR_MESSAGES ? messageFor(code as ErrorCode) : 'Not available';
  return (
    <div className="space-y-4">
      <Link href="/inbox" className="text-sm text-slate-600">
        ← To do list
      </Link>
      <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <h1 className="text-lg font-semibold">Shift swap</h1>
        <p className="text-sm text-slate-600 tabular-nums">
          {formatDay(s.local_date)} · {formatSpan(s.start_at, s.end_at, s.tz ?? 'Asia/Kolkata')} ·{' '}
          {title(s.role_code)}
        </p>
        <p className="mt-2" data-testid="swap-parties">
          {s.from_name ?? 'Worker'} → {s.to_name ?? 'Worker'}
        </p>
        {s.note && <p className="mt-1 text-sm">“{s.note}”</p>}
        <p className="mt-1 text-sm text-slate-600" data-testid="swap-status">
          Status: {STATUS[s.status] ?? s.status}
          {s.status === 'reassigned' && s.reassigned_name ? ` (${s.reassigned_name})` : ''}
        </p>
      </div>

      {blockers.length > 0 && (
        <div role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800">
          <p className="font-medium">This swap can&apos;t be approved</p>
          <ul className="mt-1 list-disc pl-5">
            {blockers.map((b) => (
              <li key={b.code}>
                {to}: {reason(b.code)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div
          data-testid="swap-warnings"
          className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200"
        >
          <p className="font-medium">Check before you approve</p>
          <ul className="mt-1 list-disc pl-5">
            {warnings.map((w) => (
              <li key={w.code}>{warningSentence(to, w.detail)}</li>
            ))}
          </ul>
          <p className="mt-1">You can still approve it.</p>
        </div>
      )}
      {open && s.wf_request_id && (
        <SwapDecision
          swap={s.id}
          requestId={s.wf_request_id}
          accept={warnings.map((w) => w.code)}
        />
      )}

      {open && s.can_roster && (
        <section className="space-y-2">
          <h2 className="font-medium">Or give the shift to someone else</h2>
          <p className="text-sm text-slate-600">
            It goes straight onto their roster, with no further approval, and the swap closes.
          </p>
          {others.length === 0 ? (
            <Empty>No one else here can take it.</Empty>
          ) : (
            <ul className="space-y-2" data-testid="reassign-candidates">
              {others.map((p) => (
                <li
                  key={p.worker_id}
                  data-testid="reassign-candidate"
                  className="flex items-center justify-between gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-200"
                >
                  <span>
                    <span className="block font-medium">{p.display_name}</span>
                    <span className="block text-xs text-slate-500">{p.week_hours} h this week</span>
                    {p.warnings.map((w) => (
                      <span key={w.code} className="block text-xs text-amber-800">
                        {warningPhrase(w.detail)}
                      </span>
                    ))}
                  </span>
                  <ReassignButton
                    swap={s.id}
                    worker={p.worker_id}
                    accept={p.warnings.map((w) => w.code)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
