import Link from 'next/link';
import { Empty } from '@/components/messages';
import { PeopleHeader } from '@/components/people-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { addDays, formatDay, formatSpan, isIsoDate, localToday, weekStart } from '@/lib/dates';
import { sql, withUser } from '@/lib/db';
import { param, type SearchParams } from '@/lib/inventory';
import { peopleContext, weekRoster, type RosterShift } from '@/lib/people';
import { departmentSections } from '@/lib/department-groups';
import type { PlaceDepartment } from '@/lib/today-view';
import { dayStrip, groupByTime, pickDay } from '@/lib/roster-view';
import { RemoveButton, WeekActions, type TemplateWindow } from './week-actions';
import { jobTitles } from '@/lib/job-titles';

// The manager's week: build from templates, assign, publish. Mobile-first: a day strip
// (Mon–Sun, open slots per day) and one day's shifts grouped by time, names inline (ADR 025,
// UX U-11); "List view" keeps the whole week as one card per shift. Day and view live in
// the address only (?day=, ?view=list), like the place.
export default async function WeekPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams, 'roster');
  if (!ctx.can('ROSTER') || !ctx.node) {
    return <p className="text-slate-600">You don&apos;t have access to roster.</p>;
  }
  const node = ctx.node;
  const sp = await searchParams;
  const asked = param(sp, 'week');
  const monday = weekStart(isIsoDate(asked) ? asked : localToday(ctx.tz));
  const user = await requireUser();
  const title = await withUser(user.id, jobTitles);
  // "All departments" (ADR 048): every department's shifts, in a section each; Home's open
  // shifts count opens it
  const all = param(sp, 'all') === '1' && ctx.nodes.length > 1;
  const { shifts, places } = await withUser(user.id, async (tx) => {
    const shifts = await weekRoster(tx, all ? ctx.nodes.map((n) => n.id) : node.id, monday);
    const nodes = [...new Set(shifts.map((s) => s.org_node_id))];
    const places =
      all && nodes.length > 0
        ? (
            await sql<PlaceDepartment>`
              select node_id::text, department_id::text, department, rank, outlet_id::text, outlet
                from core.department_of(${nodes}::uuid[])`.execute(tx)
          ).rows
        : [];
    return { shifts, places };
  });
  const canEdit = ctx.can('ROSTER', 'modify');
  const drafts = shifts.filter((s) => s.status === 'draft').length;
  const open = shifts.reduce((n, s) => n + Math.max(0, s.headcount - s.people.length), 0);
  const window = canEdit && !all ? await templateWindow(user.id, node.id, monday) : null;
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const list = param(sp, 'view') === 'list';
  const day = pickDay(days, param(sp, 'day'), localToday(ctx.tz));
  const base = `/roster/week?node=${node.id}${all ? '&all=1' : ''}`;
  const link = (week: string) => `${base}&week=${week}${list ? '&view=list' : ''}`;
  const now = new Date();
  const editable = (s: RosterShift) => canEdit && new Date(s.start_at) > now;

  const timeGroups = (rows: RosterShift[]) =>
    groupByTime(rows).map((g) => {
      const span = formatSpan(g.start_at, g.end_at, ctx.tz);
      return (
        <section
          key={g.key}
          aria-label={span}
          className="rounded-xl bg-white ring-1 ring-slate-200"
          data-testid="time-group"
        >
          <h3 className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-sm">
            <span className="font-medium tabular-nums">{span}</span>
            {g.open > 0 && <span className="text-amber-700">{g.open} open</span>}
          </h3>
          <ul className="divide-y divide-slate-100">
            {g.shifts.map((s) => (
              <ShiftRow
                key={s.id}
                s={s}
                title={title}
                node={s.org_node_id}
                editable={editable(s)}
              />
            ))}
          </ul>
        </section>
      );
    });

  return (
    <div className="space-y-4">
      <PollRefresh />
      <PeopleHeader
        ctx={ctx}
        active="/roster/week"
        title="Roster"
        all={ctx.nodes.length > 1 ? { label: 'All departments', on: all } : undefined}
      />
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
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-slate-600" data-testid="week-summary">
          {shifts.length} shifts · {drafts} draft · {open} open slot{open === 1 ? '' : 's'}
        </p>
        <Link
          href={list ? `${base}&week=${monday}&day=${day}` : `${base}&week=${monday}&view=list`}
          className="flex min-h-11 shrink-0 items-center px-2 text-sm text-slate-700 underline"
        >
          {list ? 'Day view' : 'List view'}
        </Link>
      </div>
      {window && <WeekActions node={node.id} monday={monday} drafts={drafts} window={window} />}
      {shifts.length === 0 ? (
        <Empty>No shifts this week yet.{canEdit ? ' Add them from the templates.' : ''}</Empty>
      ) : list ? (
        (() => {
          const byDay = (rows: RosterShift[]) =>
            days.map((d) => {
              const dayShifts = rows.filter((s) => s.local_date === d);
              if (dayShifts.length === 0) return null;
              return (
                <section key={d} className="space-y-2" aria-label={formatDay(d)}>
                  <h2 className="text-sm font-semibold text-slate-700">{formatDay(d)}</h2>
                  <ul className="space-y-2">
                    {dayShifts.map((s) => (
                      <ShiftCard
                        key={s.id}
                        s={s}
                        tz={ctx.tz}
                        title={title}
                        node={s.org_node_id}
                        editable={editable(s)}
                      />
                    ))}
                  </ul>
                </section>
              );
            });
          return all
            ? departmentSections(shifts, places).map((sec) => (
                <details
                  key={sec.key}
                  open
                  className="rounded-xl bg-slate-50 p-2 ring-1 ring-slate-200"
                  data-testid="department-section"
                  data-department={sec.label}
                >
                  <summary className="flex min-h-11 cursor-pointer items-center px-1 text-sm font-semibold">
                    {sec.label}
                  </summary>
                  <div className="space-y-3 pt-2">{byDay(sec.rows)}</div>
                </details>
              ))
            : byDay(shifts);
        })()
      ) : (
        <>
          <nav aria-label="Days" className="grid grid-cols-7 gap-1">
            {dayStrip(shifts, days).map((c, i) => (
              <Link
                key={c.day}
                href={`${base}&week=${monday}&day=${c.day}`}
                aria-current={c.day === day ? 'date' : undefined}
                aria-label={`${formatDay(c.day)}: ${c.shifts} shift${c.shifts === 1 ? '' : 's'}, ${c.open} open slot${c.open === 1 ? '' : 's'}${c.drafts ? `, ${c.drafts} draft` : ''}`}
                data-testid="day-chip"
                data-open={c.open}
                className={`relative flex min-h-16 flex-col items-center justify-center rounded-lg text-xs ${
                  c.day === day
                    ? 'bg-brand-700 text-white'
                    : 'bg-white text-slate-700 ring-1 ring-slate-200'
                }`}
              >
                {c.drafts > 0 && (
                  <span
                    aria-hidden
                    className="absolute top-1 right-1 size-2 rounded-full bg-amber-400"
                  />
                )}
                <span>{WEEKDAYS[i]}</span>
                <span className="text-base font-semibold tabular-nums">
                  {Number(c.day.slice(8))}
                </span>
                <span
                  className={
                    c.day === day
                      ? ''
                      : c.open > 0
                        ? 'text-amber-700'
                        : c.shifts > 0
                          ? 'text-emerald-700'
                          : 'text-slate-400'
                  }
                >
                  {c.shifts === 0 ? '–' : c.open > 0 ? `${c.open} open` : 'full'}
                </span>
              </Link>
            ))}
          </nav>
          <section className="space-y-3" aria-label={formatDay(day)} data-testid="roster-day">
            <h2 className="text-sm font-semibold text-slate-700">{formatDay(day)}</h2>
            {all
              ? departmentSections(
                  shifts.filter((s) => s.local_date === day),
                  places,
                ).map((sec, i, list) => {
                  const open = sec.rows.reduce(
                    (n, s) => n + Math.max(0, s.headcount - s.people.length),
                    0,
                  );
                  // the department with open slots is open; if none has, the first is
                  const first = list.findIndex((x) =>
                    x.rows.some((s) => s.headcount > s.people.length),
                  );
                  const isOpen = open > 0 || (first === -1 && i === 0);
                  return (
                    <details
                      key={sec.key}
                      open={isOpen}
                      className="rounded-xl bg-slate-50 p-2 ring-1 ring-slate-200"
                      data-testid="department-section"
                      data-department={sec.label}
                    >
                      <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 px-1 text-sm font-semibold">
                        <span>{sec.label}</span>
                        <span className="font-normal text-slate-600">
                          {sec.rows.length} shift{sec.rows.length === 1 ? '' : 's'}
                          {open > 0 ? <span className="text-amber-700"> · {open} open</span> : ''}
                        </span>
                      </summary>
                      <div className="space-y-3 pt-2">{timeGroups(sec.rows)}</div>
                    </details>
                  );
                })
              : timeGroups(shifts.filter((s) => s.local_date === day))}
            {!shifts.some((s) => s.local_date === day) && <Empty>No shifts this day.</Empty>}
          </section>
        </>
      )}
    </div>
  );
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

type Title = (code: string) => string;

/** "Evening · server · 1/2", with a draft badge. */
function ShiftLabel({ s, title }: { s: RosterShift; title: Title }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-sm">
        {s.template_name ?? 'Shift'} · {title(s.role_code)} · {s.people.length}/{s.headcount}
      </span>
      {s.status === 'draft' && (
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">draft</span>
      )}
    </span>
  );
}

function AssignLink({ s, node }: { s: RosterShift; node: string }) {
  return (
    <Link
      href={`/roster/shift/${s.id}?node=${node}`}
      className="mt-2 flex min-h-11 items-center justify-center rounded-lg text-sm font-medium ring-1 ring-slate-300"
    >
      Assign ({s.headcount - s.people.length} open)
    </Link>
  );
}

/** Day view: one row per shift in its time group, names inline (UX U-11). */
function ShiftRow({
  s,
  title,
  node,
  editable,
}: {
  s: RosterShift;
  title: Title;
  node: string;
  editable: boolean;
}) {
  return (
    <li className="px-3 py-2" data-testid="roster-shift">
      <ShiftLabel s={s} title={title} />
      {s.people.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1">
          {s.people.map((p) => (
            <li
              key={p.assignment_id}
              className="flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pr-0.5 pl-3 text-sm"
            >
              {p.name}
              {editable ? (
                <RemoveButton assignment={p.assignment_id} name={p.name} />
              ) : (
                <span className="pr-2" />
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && s.people.length < s.headcount && <AssignLink s={s} node={node} />}
    </li>
  );
}

/** List view: the whole week, one card per shift. */
function ShiftCard({
  s,
  tz,
  title,
  node,
  editable,
}: {
  s: RosterShift;
  tz: string;
  title: Title;
  node: string;
  editable: boolean;
}) {
  return (
    <li className="rounded-xl bg-white p-3 ring-1 ring-slate-200" data-testid="roster-shift">
      <span className="block font-medium tabular-nums">{formatSpan(s.start_at, s.end_at, tz)}</span>
      <ShiftLabel s={s} title={title} />
      <ul className="mt-2 space-y-1">
        {s.people.map((p) => (
          <li key={p.assignment_id} className="flex items-center justify-between gap-2">
            <span className="text-sm">{p.name}</span>
            {editable && <RemoveButton assignment={p.assignment_id} name={p.name} />}
          </li>
        ))}
      </ul>
      {editable && s.people.length < s.headcount && <AssignLink s={s} node={node} />}
    </li>
  );
}

/** Tomorrow to day 7 for this place, and what adding its template shifts would do. */
async function templateWindow(
  userId: string,
  node: string,
  monday: string,
): Promise<TemplateWindow> {
  const p = await withUser(userId, async (tx) => {
    const r = await sql<{ to_add: number; drafts: number; from_day: string; to_day: string }>`
      select to_add, drafts, from_day::text, to_day::text
        from hr.preview_template_shifts(${node}::uuid)`.execute(tx);
    return r.rows[0]!;
  });
  const sunday = addDays(monday, 6);
  return {
    toAdd: p.to_add,
    drafts: p.drafts,
    span: `${formatDay(p.from_day)} – ${formatDay(p.to_day)}`,
    nextWeek:
      p.to_day > sunday && p.from_day <= sunday
        ? `/roster/week?node=${node}&week=${addDays(monday, 7)}`
        : null,
  };
}
