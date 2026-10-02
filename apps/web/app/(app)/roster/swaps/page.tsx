import { Empty } from '@/components/messages';
import { PeopleHeader } from '@/components/people-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { formatDay, formatSpan, localDate } from '@/lib/dates';
import { withUser } from '@/lib/db';
import type { SearchParams } from '@/lib/inventory';
import { mySwaps, peopleContext } from '@/lib/people';
import { SwapResponse } from './swap-response';
import { jobTitles } from '@/lib/job-titles';
import { ModuleOff } from '@/components/module-gate';

const STATUS: Record<string, string> = {
  proposed: 'Waiting for your colleague',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
  submitted: 'Waiting for manager approval',
  approved: 'Approved',
  rejected: 'Not approved',
  cancelled: 'Cancelled',
  reassigned: 'Your manager gave the shift to someone else',
};

// Shift swaps I offered or was offered. The colleague accepting sends it to the manager.
export default async function SwapsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams);
  if (!ctx.shell.modules.has('swaps')) return <ModuleOff code="swaps" />;
  const user = await requireUser();
  const title = await withUser(user.id, jobTitles);
  const swaps = await withUser(user.id, (tx) => mySwaps(tx));
  return (
    <div className="space-y-4">
      <PollRefresh />
      <PeopleHeader ctx={ctx} active="/roster/swaps" title="Shift swaps" />
      <p className="text-sm text-slate-600">
        Offer one of your shifts from My shifts. Your colleague accepts, then your manager approves.
      </p>
      {swaps.length === 0 ? (
        <Empty>No swaps yet.</Empty>
      ) : (
        <ul className="space-y-2" data-testid="swaps">
          {swaps.map((s) => (
            <li key={s.swap_id} className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
              <p className="font-medium">
                {s.direction === 'incoming'
                  ? `${s.from_name} offers you`
                  : `You offered ${s.to_name}`}
              </p>
              <p className="text-sm text-slate-600 tabular-nums">
                {formatDay(localDate(s.start_at, ctx.tz))} ·{' '}
                {formatSpan(s.start_at, s.end_at, ctx.tz)} · {title(s.role_code)}
              </p>
              {s.note && <p className="mt-1 text-sm">“{s.note}”</p>}
              <p className="mt-1 text-xs text-slate-500">{STATUS[s.status] ?? s.status}</p>
              {s.status === 'proposed' && <SwapResponse swap={s.swap_id} direction={s.direction} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
