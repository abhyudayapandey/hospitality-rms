import Link from 'next/link';
import { Empty } from '@/components/messages';
import { PeopleHeader } from '@/components/people-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { addDays, formatDay, formatSpan, isIsoDate, localToday, weekStart } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { param, type SearchParams } from '@/lib/inventory';
import { peopleContext, weekRoster } from '@/lib/people';
import { RemoveButton, WeekActions } from './week-actions';

// The manager's week: build from templates, assign, publish. Mobile-first: one column,
// grouped by day; each shift shows who is on it and the open slots.
export default async function WeekPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams);
  if (!ctx.can('ROSTER') || !ctx.node) {
    return <p className="text-slate-600">You don&apos;t have access to roster.</p>;
  }
  const node = ctx.node;
  const sp = await searchParams;
  const asked = param(sp, 'week');
  const monday = weekStart(isIsoDate(asked) ? asked : localToday(ctx.tz));
  const user = await requireUser();
  const shifts = await withUser(user.id, (tx) => weekRoster(tx, node.id, monday));
  const canEdit = ctx.can('ROSTER', 'modify');
  const drafts = shifts.filter((s) => s.status === 'draft').length;
  const open = shifts.reduce((n, s) => n + Math.max(0, s.headcount - s.people.length), 0);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const link = (week: string) => `/roster/week?node=${node.id}&week=${week}`;

  return (
    <div className="space-y-4">
      <PollRefresh />
      <PeopleHeader ctx={ctx} active="/roster/week" title="Roster" picker />
      <div className="flex items-center justify-between gap-2">
        <Link
          href={link(addDays(monday, -7))}
          className="flex min-h-11 items-center rounded-lg px-3 ring-1 ring-slate-300"
          aria-label="Previous week"
        >
          ←
        </Link>
        <p className="text-center font-medium" data-testid="week-label">
          Week of {formatDay(monday)}
        </p>
        <Link
          href={link(addDays(monday, 7))}
          className="flex min-h-11 items-center rounded-lg px-3 ring-1 ring-slate-300"
          aria-label="Next week"
        >
          →
        </Link>
      </div>
      <p className="text-sm text-slate-600" data-testid="week-summary">
        {shifts.length} shifts · {drafts} draft · {open} open slot{open === 1 ? '' : 's'}
      </p>
      {canEdit && (
        <WeekActions node={node.id} monday={monday} drafts={drafts} empty={shifts.length === 0} />
      )}
      {shifts.length === 0 ? (
        <Empty>No shifts this week yet.{canEdit ? ' Build them from the templates.' : ''}</Empty>
      ) : (
        days.map((day) => {
          const list = shifts.filter((s) => s.local_date === day);
          if (list.length === 0) return null;
          return (
            <section key={day} className="space-y-2" aria-label={formatDay(day)}>
              <h2 className="text-sm font-semibold text-slate-700">{formatDay(day)}</h2>
              <ul className="space-y-2">
                {list.map((s) => (
                  <li
                    key={s.id}
                    className="rounded-xl bg-white p-3 ring-1 ring-slate-200"
                    data-testid="roster-shift"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span>
                        <span className="block font-medium tabular-nums">
                          {formatSpan(s.start_at, s.end_at, ctx.tz)}
                        </span>
                        <span className="text-xs text-slate-500">
                          {s.template_name ?? 'Shift'} · {s.role_code.toLowerCase()} ·{' '}
                          {s.people.length}/{s.headcount}
                        </span>
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          s.status === 'draft'
                            ? 'bg-amber-50 text-amber-800'
                            : 'bg-emerald-50 text-emerald-800'
                        }`}
                      >
                        {s.status}
                      </span>
                    </div>
                    <ul className="mt-2 space-y-1">
                      {s.people.map((p) => (
                        <li
                          key={p.assignment_id}
                          className="flex items-center justify-between gap-2"
                        >
                          <span className="text-sm">{p.name}</span>
                          {canEdit && new Date(s.start_at) > new Date() && (
                            <RemoveButton assignment={p.assignment_id} name={p.name} />
                          )}
                        </li>
                      ))}
                    </ul>
                    {canEdit &&
                      s.people.length < s.headcount &&
                      new Date(s.start_at) > new Date() && (
                        <Link
                          href={`/roster/shift/${s.id}?node=${node.id}`}
                          className="mt-2 flex min-h-11 items-center justify-center rounded-lg text-sm font-medium ring-1 ring-slate-300"
                        >
                          Assign ({s.headcount - s.people.length} open)
                        </Link>
                      )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
