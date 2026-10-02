import Link from 'next/link';
import { formatLongDay, formatTime } from '@/lib/dates';
import { moreItems, visibleNav } from '@/lib/nav';
import { compare, formatMeasure, MEASURES, type MeasureRow } from '@/lib/reports';
import { loadShell, navInput } from '@/lib/shell';
import { loadToday, type TodayNumbers } from '@/lib/today';
import {
  attentionLines,
  shiftLine,
  splitShortcuts,
  todaysTasks,
  type Shortcut,
} from '@/lib/today-view';

// Home is "Today" (UX review U-1, UX-2): a short list of cards, each with one action,
// shown by what the person has: their shift, their tasks, what waits for them, what needs
// attention (leads), today's numbers (outlet, department, cost and owner roles; ADR 023)
// and at most four shortcuts. Every other screen is under "All screens". Shortcuts need
// the same access as the screen they open (audit #3); shifts, clock and swaps only for
// people who work at an outlet (audit #13).
const can = (
  domains: Map<string, 'view' | 'modify'>,
  domain: string,
  access: 'view' | 'modify' = 'view',
) => domains.has(domain) && (access === 'view' || domains.get(domain) === 'modify');

const card = 'block rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200';
const button =
  'flex min-h-12 w-full items-center justify-center rounded-lg bg-slate-900 font-medium text-white';

export default async function Home() {
  const shell = await loadShell();
  const atWork = shell.home?.at_workplace ?? false;
  const tz = shell.nodes.find((n) => n.id === shell.home?.id)?.timezone ?? 'Asia/Kolkata';
  const today = await loadToday(shell, tz);
  const now = new Date();
  const input = navInput(shell);
  const inNav = new Set(visibleNav(input).map((n) => n.href));
  const tasks = todaysTasks(today.tasks, now, tz);
  const attention = today.attention ? attentionLines(today.attention) : [];

  // shortcuts, most useful first: reports, requests, admin, menu, then people and supply
  const more: Shortcut[] = moreItems(input).map((item) =>
    item.href === '/reports' && shell.reports === 'mine'
      ? { href: '/reports/my-week', label: 'My week' }
      : {
          href: item.href,
          label:
            item.label === 'Requests'
              ? 'My requests'
              : // without menu costs, the Menu screen is the recipes (UX U-4)
                item.href === '/menu' && !shell.domains.has('MENU')
                ? 'Recipes'
                : item.label,
        },
  );
  const order = ['/reports', '/reports/my-week', '/requests', '/admin', '/menu'];
  more.sort((a, b) => order.indexOf(a.href) - order.indexOf(b.href));
  const extra = (
    [
      ['/roster/my', 'My shifts', atWork && can(shell.domains, 'ROSTER')],
      ['/leave', 'Leave', can(shell.domains, 'LEAVE')],
      ['/events', 'Events', can(shell.domains, 'EVENTS')],
      ['/stock', 'Stock', can(shell.domains, 'STOCK_LEVELS')],
      ['/stock/count', 'Count', can(shell.domains, 'STOCK_ADJUSTMENTS', 'modify')],
      ['/stock/wastage', 'Wastage', can(shell.domains, 'STOCK_ADJUSTMENTS', 'modify')],
      ['/stock/production', 'Production', shell.production],
      ['/stock/orders', 'Orders', can(shell.domains, 'PURCHASE_ORDERS')],
      ['/stock/transfers', 'Transfers', can(shell.domains, 'TRANSFERS')],
      ['/roster/clock', 'Clock', atWork && can(shell.domains, 'ATTENDANCE', 'modify')],
    ] as const
  )
    .filter(([href, , show]) => show && !inNav.has(href))
    .map(([href, label]) => ({ href, label }));
  const { shortcuts, rest } = splitShortcuts([...more, ...extra]);

  return (
    <div className="space-y-4">
      {/* the date, not "Hello, <first word of the name>" (UX U-2): the header has the name */}
      <div>
        <h1 className="text-xl font-semibold" data-testid="today">
          {formatLongDay(now, tz)}
        </h1>
        {shell.home && (
          <p className="text-sm text-slate-600">
            Working at <strong>{shell.home.name}</strong>
          </p>
        )}
      </div>

      {(today.shift || today.punch) && (
        <section aria-label="Your shift" className={card} data-testid="shift-card">
          <h2 className="text-sm font-semibold text-slate-600">Your shift</h2>
          <p className="mt-1 font-medium">
            {today.shift ? shiftLine(today.shift, now, tz) : 'No shift on now'}
          </p>
          {today.punch && (
            <p className="text-sm text-emerald-800">
              Clocked in at {formatTime(today.punch.clock_in_at, tz)}
            </p>
          )}
          <Link href="/roster/clock" className={`${button} mt-3`}>
            {today.punch ? 'Clock out' : 'Clock in'}
          </Link>
        </section>
      )}

      {shell.domains.has('TASKS') && (
        <section aria-label="Your tasks" className={card} data-testid="tasks-card">
          <h2 className="text-sm font-semibold text-slate-600">Your tasks</h2>
          {tasks.total === 0 ? (
            <p className="mt-1 text-sm text-slate-600">Nothing due today.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {tasks.shown.map((t) => (
                <li key={t.id}>
                  <Link href={`/tasks/${t.id}`} className="flex items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{t.title}</span>
                      <span className="block text-xs text-slate-500">
                        {t.place_name} · due {formatTime(t.due_at, tz)}
                      </span>
                    </span>
                    {t.overdue && (
                      <span className="shrink-0 rounded-full bg-rose-50 px-2 py-0.5 text-xs text-rose-800">
                        overdue
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link href="/tasks" className="mt-3 block text-sm font-medium underline">
            See all tasks{tasks.total > tasks.shown.length ? ` (${tasks.total})` : ''}
          </Link>
        </section>
      )}

      <Link
        href="/inbox"
        className="flex min-h-16 items-center justify-between rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
      >
        <span className="font-medium">Waiting for you</span>
        <span className="text-2xl font-semibold" data-testid="inbox-count">
          {shell.inboxCount}
        </span>
      </Link>

      {attention.length > 0 && (
        <section aria-label="Needs attention" className={card} data-testid="attention-card">
          <h2 className="text-sm font-semibold text-slate-600">Needs attention</h2>
          <ul className="mt-2 space-y-1">
            {attention.map((a) => (
              <li key={a.href}>
                <Link href={a.href} className="flex min-h-11 items-center gap-2">
                  <span className="text-lg font-semibold tabular-nums">{a.n}</span>
                  <span>{a.text}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {today.numbers && <Numbers numbers={today.numbers} />}

      {shortcuts.length > 0 && (
        <nav aria-label="More" className="grid grid-cols-2 gap-2">
          {shortcuts.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="flex min-h-14 items-center justify-center rounded-xl bg-white text-center font-medium shadow-sm ring-1 ring-slate-200"
            >
              {s.label}
            </Link>
          ))}
        </nav>
      )}
      {rest.length > 0 && (
        <details className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">All screens</summary>
          <nav aria-label="All screens" className="mt-2 grid grid-cols-2 gap-2">
            {rest.map((s) => (
              <Link
                key={s.href}
                href={s.href}
                className="flex min-h-12 items-center justify-center rounded-lg text-center ring-1 ring-slate-200"
              >
                {s.label}
              </Link>
            ))}
          </nav>
        </details>
      )}
    </div>
  );
}

/** Today's headline figures (ADR 023), each against the same day last week. */
function Numbers({ numbers }: { numbers: TodayNumbers }) {
  const by = new Map(numbers.rows.map((r) => [r.measure, r]));
  const tiles: { key: string; row: MeasureRow | undefined; label?: string }[] =
    numbers.report === 'outlet_flash'
      ? ['sales', 'food_cost_pct', 'bar_cost_pct', 'wastage'].map((k) => ({
          key: k,
          row: by.get(k),
        }))
      : [
          { key: 'shifts', row: by.get('shifts'), label: 'Shifts today' },
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
      <h2 className="text-sm font-semibold text-slate-600">Today so far · {numbers.place.name}</h2>
      <dl className="mt-2 grid grid-cols-2 gap-3">
        {tiles.map(({ key, row, label }) => {
          const def = MEASURES[key] ?? { label: label ?? key, unit: 'count' as const };
          const c = compare(def, row?.value, row?.last_week);
          return (
            <div key={key} data-testid={`tile-${key}`}>
              <dt className="text-xs text-slate-500">{label ?? def.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {formatMeasure(def.unit, row?.value)}
              </dd>
              {c.text && (
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
              )}
            </div>
          );
        })}
      </dl>
      <Link href={href} className="mt-3 block text-sm font-medium underline">
        Open the report
      </Link>
    </section>
  );
}
