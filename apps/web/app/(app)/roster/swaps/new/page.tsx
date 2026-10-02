import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { formatDay, formatSpan } from '@/lib/dates';
import { sql, withUser } from '@/lib/db';
import { isUuid, param, type SearchParams } from '@/lib/inventory';
import { peopleContext } from '@/lib/people';
import { OfferForm } from './offer-form';
import { jobTitles } from '@/lib/job-titles';
import { ModuleOff } from '@/components/module-gate';

// Offer one of my shifts to a colleague with the same role at my location. Names come
// from hr.worker_directory (display name, role, node only).
export default async function NewSwapPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams);
  if (!ctx.shell.modules.has('swaps')) return <ModuleOff code="swaps" />;
  const assignment = param(await searchParams, 'assignment');
  if (!isUuid(assignment)) return <Empty>That shift can&apos;t be swapped.</Empty>;
  const user = await requireUser();
  const title = await withUser(user.id, jobTitles);
  const data = await withUser(user.id, async (tx) => {
    const a = await sql<{
      id: string;
      local_date: string;
      start_at: Date;
      end_at: Date;
      role_code: string;
      org_node_id: string;
      worker_id: string;
    }>`
      select a.id, s.local_date::text as local_date, s.start_at, s.end_at, s.role_code,
             s.org_node_id, a.worker_id
        from hr.shift_assignment a join hr.shift s on s.id = a.shift_id
       where a.id = ${assignment}::uuid and a.owner_user_id = core.current_user_id()
         and a.status = 'assigned'`.execute(tx);
    const shift = a.rows[0];
    if (!shift) return null;
    const colleagues = await sql<{ worker_id: string; display_name: string }>`
      select worker_id, display_name from hr.worker_directory
       where org_node_id = ${shift.org_node_id}::uuid and role_code = ${shift.role_code}
         and worker_id <> ${shift.worker_id}::uuid
       order by display_name`.execute(tx);
    return { shift, colleagues: colleagues.rows };
  });
  if (!data) return <Empty>That shift can&apos;t be swapped.</Empty>;
  const { shift, colleagues } = data;
  return (
    <div className="space-y-4">
      <Link href="/roster/my" className="text-sm text-slate-600">
        ← My shifts
      </Link>
      <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <h1 className="text-lg font-semibold">Offer a shift</h1>
        <p className="text-sm text-slate-600 tabular-nums">
          {formatDay(shift.local_date)} · {formatSpan(shift.start_at, shift.end_at, ctx.tz)} ·{' '}
          {title(shift.role_code)}
        </p>
      </div>
      {colleagues.length === 0 ? (
        <Empty>No colleague with the same role works here.</Empty>
      ) : (
        <OfferForm assignment={shift.id} colleagues={colleagues} />
      )}
    </div>
  );
}
