import Link from 'next/link';
import { ExpiryBanner } from '@/components/expiry-banner';
import { Icon, type IconName } from '@/components/icon';
import { formatDay, formatLongDay, formatTime } from '@/lib/dates';
import { compare, formatMeasure, MEASURES, type MeasureRow } from '@/lib/reports';
import { homeTiles } from '@/lib/screens';
import { vsTarget, type TargetKey } from '@/lib/settings';
import { loadShell, screenInput } from '@/lib/shell';
import { HOME_APPROVALS, loadToday, type Today, type TodayNumbers } from '@/lib/today';
import type { MyTask } from '@/lib/tasks';
import { shiftLine, todaysTasks } from '@/lib/today-view';
import { InboxItem } from './inbox/inbox-item';

// Home is "Today" (UX-2), simplified for each role (UX-6, ADR 034): what the person must
// do now comes first, in pictures and numbers before words.
// - Everyone with a shift: one card with the shift and one big Clock in or out.
// - Frontline staff: the next job, then four tiles (their tasks, what they make, their
//   shifts, leave or reporting a problem). Nothing else: the rest is on Me.
// - The store keeper: four tiles with what waits (deliveries, transfers to send, items
//   running low, the count).
// - Leads: the expiry banners, what needs their yes (Approve and No on Home), what needs
//   attention by department in red or amber, and today's figures against the company's
//   targets; across outlets, the outlets side by side.
// Every card reads what the person can already see under RLS; none decides access.

const card = 'block rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200';
const cardTitle = 'text-xs font-semibold tracking-wide text-slate-500 uppercase';

export default async function Home() {
  const shell = await loadShell();
  const tz = shell.nodes.find((n) => n.id === shell.home?.id)?.timezone ?? 'Asia/Kolkata';
  const today = await loadToday(shell, tz);
  const now = new Date();
  const tasks = todaysTasks(today.tasks, now, tz);
  const frontline = today.profile === 'frontline';
  const tiles = frontline
    ? homeTiles(screenInput(shell)).map((t) => ({
        ...t,
        badge:
          t.key === 'tasks'
            ? { n: tasks.total, tone: tasks.shown.some((x) => x.overdue) ? 'bad' : 'brand' }
            : t.key === 'make'
              ? { n: today.tasks.filter((x) => x.kind === 'prep').length, tone: 'brand' }
              : null,
      }))
    : [];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold" data-testid="today">
        {formatLongDay(now, tz)}
      </h1>

      <Banners today={today} />

      {(today.shift || today.punch) && (
        <section
          aria-label="Your shift"
          className="space-y-3 rounded-2xl bg-brand-700 p-4 text-white"
          data-testid="shift-card"
        >
          <p className="text-sm text-brand-100">
            {today.punch
              ? `On shift since ${formatTime(today.punch.clock_in_at, tz)}`
              : today.shift
                ? shiftLine(today.shift, now, tz)
                : ''}
          </p>
          <p className="text-2xl font-bold">{today.punch ? 'Clocked in' : 'Not clocked in'}</p>
          <Link
            href="/roster/clock"
            className="flex min-h-13 items-center justify-center gap-2 rounded-xl bg-white text-lg font-semibold text-brand-700"
          >
            <Icon name="clock" />
            {today.punch ? 'Clock out' : 'Clock in'}
          </Link>
        </section>
      )}

      {(frontline || tasks.total > 0) && shell.domains.has('TASKS') && (
        <NextTask tasks={tasks} tz={tz} frontline={frontline} />
      )}

      {tiles.length > 0 && (
        <nav aria-label="My jobs" className="grid grid-cols-2 gap-3" data-testid="tiles">
          {tiles.map((t) => (
            <Tile
              key={t.key}
              href={t.href}
              icon={t.icon}
              label={t.label}
              testId={`tile-${t.key}`}
              badge={t.badge && t.badge.n > 0 ? t.badge : null}
            />
          ))}
        </nav>
      )}

      {today.store && (
        <nav aria-label="Store jobs" className="grid grid-cols-2 gap-3" data-testid="tiles">
          <Tile
            href="/stock/orders"
            icon="truck"
            label="Receive"
            note={`${today.store.receive} to come`}
            testId="tile-receive"
            badge={today.store.receive > 0 ? { n: today.store.receive, tone: 'warn' } : null}
          />
          <Tile
            href="/inbox"
            icon="box"
            label="Send"
            note={`${today.store.issue} to send`}
            testId="tile-issue"
            badge={today.store.issue > 0 ? { n: today.store.issue, tone: 'bad' } : null}
          />
          <Tile
            href="/stock?low=1"
            icon="down"
            label="Running low"
            note={today.store.low > 0 ? 'order now' : 'nothing low'}
            testId="tile-low"
            badge={today.store.low > 0 ? { n: today.store.low, tone: 'bad' } : null}
          />
          <Tile href="/stock/count" icon="clipboard" label="Count" testId="tile-count" />
        </nav>
      )}

      <Approvals today={today} />

      <Attention today={today} />

      {today.league ? (
        <League league={today.league} targets={today.targets} />
      ) : (
        today.numbers && <Numbers numbers={today.numbers} targets={today.targets} />
      )}
    </div>
  );
}

function Banners({ today }: { today: Today }) {
  const e = today.expiry;
  if (!e) return null;
  return (
    <>
      {(['expiring', 'expired'] as const)
        .filter((k) => e[k].n > 0)
        .map((k) => (
          <ExpiryBanner
            key={k}
            show={k}
            n={e[k].n}
            q={e[k].store ? `node=${e[k].store}&` : 'all=1&'}
          />
        ))}
    </>
  );
}

function NextTask({
  tasks,
  tz,
  frontline,
}: {
  tasks: { shown: MyTask[]; total: number };
  tz: string;
  frontline: boolean;
}) {
  const next = tasks.shown[0];
  return (
    <section aria-label="Next" className={card} data-testid="tasks-card">
      <h2 className={cardTitle}>{frontline ? 'Next' : 'Your tasks'}</h2>
      {!next ? (
        <p className="mt-2 flex items-center gap-2 text-slate-600">
          <Icon name="check" className="size-5 text-emerald-700" />
          Nothing due today
        </p>
      ) : (
        <>
          <Link href={`/tasks/${next.id}`} className="mt-2 flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
              <Icon
                name={next.kind === 'prep' ? 'pot' : next.kind === 'checklist' ? 'tasks' : 'list'}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{next.title}</span>
              <span className="block text-sm text-slate-500">by {formatTime(next.due_at, tz)}</span>
            </span>
            <span
              className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                next.overdue ? 'bg-rose-50 text-rose-800' : 'bg-amber-50 text-amber-800'
              }`}
            >
              {next.overdue ? 'Late' : 'Due today'}
            </span>
          </Link>
          {frontline && (
            <Link
              href={`/tasks/${next.id}`}
              className="mt-3 flex min-h-13 items-center justify-center rounded-xl bg-brand-700 text-lg font-semibold text-white"
            >
              Start
            </Link>
          )}
          {tasks.total > 1 && (
            <Link href="/tasks" className="mt-3 block text-sm font-medium text-brand-700">
              {tasks.total - 1} more today
            </Link>
          )}
        </>
      )}
    </section>
  );
}

type Tone = 'bad' | 'warn' | 'brand';
const BADGE: Record<Tone, string> = {
  bad: 'bg-rose-50 text-rose-700',
  warn: 'bg-amber-50 text-amber-800',
  brand: 'bg-brand-100 text-brand-700',
};

function Tile({
  href,
  icon,
  label,
  note,
  testId,
  badge = null,
}: {
  href: string;
  icon: IconName;
  label: string;
  note?: string;
  testId: string;
  badge?: { n: number; tone: string } | null;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="relative flex min-h-26 flex-col justify-between gap-2 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
    >
      <Icon name={icon} className="size-8 text-brand-700" />
      <span>
        <span className="block font-semibold">{label}</span>
        {note && <span className="block text-xs text-slate-500">{note}</span>}
      </span>
      {badge && (
        <span
          data-testid="tile-badge"
          className={`absolute top-3 right-3 min-w-7 rounded-full px-2 py-0.5 text-center text-sm font-bold tabular-nums ${BADGE[badge.tone as Tone] ?? BADGE.brand}`}
        >
          {badge.n}
        </span>
      )}
    </Link>
  );
}

/** What waits for the person's yes (UX-6): the first few, decided right here. */
function Approvals({ today }: { today: Today }) {
  const { shown, total, toAssign } = today.approvals;
  if (total === 0 && toAssign === 0) return null;
  return (
    <section aria-label="Needs your yes" className={card} data-testid="approvals-card">
      <div className="flex items-center justify-between">
        <h2 className={cardTitle}>Needs your yes</h2>
        <span className="rounded-full bg-rose-50 px-2 text-sm font-bold text-rose-700 tabular-nums">
          {total + toAssign}
        </span>
      </div>
      {shown.length > 0 && (
        <ul className="mt-2 divide-y divide-slate-100">
          {shown.map((e) => (
            <InboxItem key={e.requestId} entry={e} compact />
          ))}
        </ul>
      )}
      {toAssign > 0 && (
        <Link href="/inbox" className="mt-3 flex min-h-11 items-center gap-2 font-medium">
          <Icon name="tasks" className="size-5 text-brand-700" />
          {toAssign} to give to someone
        </Link>
      )}
      {total > HOME_APPROVALS && (
        <Link href="/inbox" className="mt-2 block text-sm font-medium text-brand-700">
          See all {total}
        </Link>
      )}
    </section>
  );
}

const TONE_BAR = { bad: 'border-rose-500', warn: 'border-amber-400' } as const;
const TONE_CHIP = { bad: 'bg-rose-50 text-rose-700', warn: 'bg-amber-50 text-amber-800' } as const;

/** By department, Kitchen first (DB-2), each red or amber (UX-6). */
function Attention({ today }: { today: Today }) {
  const groups = today.attention ?? [];
  if (groups.length === 0) return null;
  return (
    <section aria-label="Needs attention" className={card} data-testid="attention-card">
      <h2 className={cardTitle}>Needs attention</h2>
      <div className="mt-3 space-y-3">
        {groups.map((g) => (
          <section
            key={g.key}
            aria-label={g.label}
            className={`space-y-1 border-l-4 pl-3 ${TONE_BAR[g.tone]}`}
            data-testid="attention-group"
            data-tone={g.tone}
          >
            {/* one department needs no heading */}
            {groups.length > 1 && (
              <h3 className="flex items-center justify-between text-sm font-semibold">
                {g.label}
                <span className={`rounded-full px-2 text-xs font-bold ${TONE_CHIP[g.tone]}`}>
                  {g.total}
                </span>
              </h3>
            )}
            {/* one line per department: a few words each, every part opens its screen */}
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
              {g.lines.map((a) => (
                <Link key={a.text} href={a.href} className="inline-flex min-h-8 items-center gap-1">
                  <span className="font-semibold tabular-nums">{a.n}</span>
                  <span className="text-slate-600 underline decoration-slate-300 underline-offset-2">
                    {a.text}
                  </span>
                </Link>
              ))}
            </p>
          </section>
        ))}
      </div>
    </section>
  );
}

/** A figure, then against its target (red only when more than 2 points off) or last week. */
function Kpi({
  measure,
  row,
  label,
  targets,
}: {
  measure: string;
  row: MeasureRow | undefined;
  label?: string | undefined;
  targets: Record<TargetKey, number>;
}) {
  const def = MEASURES[measure] ?? { label: label ?? measure, unit: 'count' as const };
  const t = vsTarget(measure, row?.value, targets);
  const c = compare(def, row?.value, row?.last_week);
  const bad = t.state === 'bad';
  return (
    <div
      className={`rounded-xl p-3 ring-1 ${bad ? 'bg-rose-50 ring-rose-200' : 'bg-white ring-slate-200'}`}
      data-testid={`tile-${measure}`}
      data-state={t.state}
    >
      <dt className="text-xs text-slate-500">{label ?? def.label}</dt>
      <dd className={`text-xl font-bold tabular-nums ${bad ? 'text-rose-700' : 'text-slate-900'}`}>
        {formatMeasure(def.unit, row?.value)}
      </dd>
      {t.target !== null ? (
        <dd className="text-xs text-slate-500">target {t.target}%</dd>
      ) : (
        c.text && (
          <dd
            className={`text-xs ${
              c.trend === 'good'
                ? 'text-emerald-700'
                : c.trend === 'bad'
                  ? 'text-rose-700'
                  : 'text-slate-500'
            }`}
          >
            {c.text}
          </dd>
        )
      )}
    </div>
  );
}

/** Today's headline figures (ADR 023), against target or the same day last week. */
function Numbers({
  numbers,
  targets,
}: {
  numbers: TodayNumbers;
  targets: Record<TargetKey, number>;
}) {
  const by = new Map(numbers.rows.map((r) => [r.measure, r]));
  const tiles: { key: string; row: MeasureRow | undefined; label?: string }[] =
    numbers.report === 'outlet_flash'
      ? ['sales', 'food_cost_pct', 'bar_cost_pct', 'wastage'].map((k) => ({
          key: k,
          row: by.get(k),
        }))
      : [
          { key: 'shifts', row: by.get('shifts'), label: 'On shift today' },
          {
            key: 'not_in',
            row: { measure: 'not_in', value: String(numbers.notIn ?? 0) },
            label: 'Not in yet',
          },
          { key: 'open_slots', row: by.get('open_slots') },
          { key: 'task_pct', row: by.get('task_pct') },
        ];
  const href =
    numbers.report === 'outlet_flash'
      ? `/reports/outlet?node=${numbers.place.id}`
      : `/reports/department?node=${numbers.place.id}`;
  return (
    <section aria-label="Today's numbers" className={card} data-testid="numbers-card">
      <h2 className={cardTitle}>Today so far · {numbers.place.name}</h2>
      <dl className="mt-3 grid grid-cols-2 gap-2">
        {tiles.map(({ key, row, label }) => (
          <Kpi key={key} measure={key} row={row} label={label} targets={targets} />
        ))}
      </dl>
      <Link href={href} className="mt-3 flex items-center gap-1 text-sm font-medium text-brand-700">
        Open the report <Icon name="chevron" className="size-4" />
      </Link>
    </section>
  );
}

/** Outlets side by side for the last 7 days (R-4), red against target (UX-6). */
function League({
  league,
  targets,
}: {
  league: NonNullable<Today['league']>;
  targets: Record<TargetKey, number>;
}) {
  const cols = [
    { key: 'sales', label: 'Sales', unit: 'money' as const },
    { key: 'food_pct', label: 'Food', unit: 'pct' as const },
    { key: 'labour_pct', label: 'People', unit: 'pct' as const },
  ] as const;
  return (
    <section aria-label="Outlets" className={card} data-testid="league-card">
      <h2 className={cardTitle}>
        Last 7 days · {formatDay(league.from)} to {formatDay(league.to)}
      </h2>
      <table className="mt-2 w-full text-sm tabular-nums">
        <thead>
          <tr className="text-xs text-slate-500">
            <th scope="col" className="py-1 text-left font-medium">
              Outlet
            </th>
            {cols.map((c) => (
              <th key={c.key} scope="col" className="py-1 text-right font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {league.rows.map((r) => (
            <tr key={r.outlet_id} className="border-t border-slate-100">
              <th scope="row" className="max-w-32 truncate py-2 text-left font-medium">
                {r.name}
              </th>
              {cols.map((c) => {
                const v = r[c.key];
                const bad = vsTarget(c.key, v, targets).state === 'bad';
                return (
                  <td
                    key={c.key}
                    className={`py-2 text-right ${bad ? 'font-bold text-rose-700' : ''}`}
                  >
                    {v === null ? '—' : formatMeasure(c.unit, v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <Link
        href={`/reports/league?node=${league.place.id}&period=custom&from=${league.from}&to=${league.to}`}
        className="mt-3 flex items-center gap-1 text-sm font-medium text-brand-700"
      >
        All figures <Icon name="chevron" className="size-4" />
      </Link>
    </section>
  );
}
