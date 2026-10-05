import Link from 'next/link';
import { FirstRun } from '@/components/first-run';
import { ExpiryBanner } from '@/components/expiry-banner';
import { Icon, type IconName } from '@/components/icon';
import { businessDate, formatDay, formatLongDay, formatTime } from '@/lib/dates';
import { compare, formatMeasure, MEASURES, type MeasureRow } from '@/lib/reports';
import { homeTiles } from '@/lib/screens';
import { vsTarget, type TargetKey } from '@/lib/settings';
import { loadShell, screenInput } from '@/lib/shell';
import { HOME_APPROVALS, loadToday, type Today, type TodayNumbers } from '@/lib/today';
import type { MyTask } from '@/lib/tasks';
import { clockable, doFirst, shiftLine, todaysTasks } from '@/lib/today-view';
import { listHref, stockHref } from '@/lib/stock-view';
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

      <FirstRun profile={today.profile} />

      <Banners today={today} />

      {(today.shift || today.punch) &&
        (today.punch || (today.shift && clockable(today.shift, now)) ? (
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
        ) : (
          // a shift later today or tomorrow: say when, offer no Clock in yet (UX-9)
          <section aria-label="Your next shift" className={card} data-testid="shift-card">
            <h2 className={cardTitle}>Your next shift</h2>
            <p className="mt-2 text-lg font-semibold">
              {today.shift ? shiftLine(today.shift, now, tz) : ''}
            </p>
            <Link href="/roster/my" className="mt-2 block text-sm font-medium text-brand-700">
              See my shifts
            </Link>
          </section>
        ))}

      {today.pos && <PosCard pos={today.pos} tz={tz} />}

      {today.push.length > 0 && <PushToday push={today.push} tz={tz} />}

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
            href={listHref('/stock/orders', { all: true, tab: 'receive' })}
            icon="truck"
            label="Receive"
            note={`${today.store.receive} to come`}
            testId="tile-receive"
            badge={today.store.receive > 0 ? { n: today.store.receive, tone: 'warn' } : null}
          />
          <Tile
            href={listHref('/stock/transfers', { all: true, tab: 'send' })}
            icon="box"
            label="Send"
            note={`${today.store.issue} to send`}
            testId="tile-issue"
            badge={today.store.issue > 0 ? { n: today.store.issue, tone: 'bad' } : null}
          />
          <Tile
            href={stockHref({ tab: 'low', all: true })}
            icon="down"
            label="Running low"
            note={today.store.low > 0 ? 'order now' : 'nothing low'}
            testId="tile-low"
            badge={today.store.low > 0 ? { n: today.store.low, tone: 'bad' } : null}
          />
          <Tile href="/stock/count" icon="clipboard" label="Count" testId="tile-count" />
        </nav>
      )}

      <DoFirst
        items={
          today.attention
            ? doFirst({
                attention: today.attention,
                overdueTasks: today.tasks.filter((x) => x.overdue).length,
                toAssign: today.approvals.toAssign,
                openSlotsHref: today.openSlotsHref,
              })
            : []
        }
      />

      <Approvals today={today} />

      {today.league ? (
        <League league={today.league} targets={today.targets} />
      ) : (
        today.numbers && <Numbers numbers={today.numbers} targets={today.targets} />
      )}

      <Attention today={today} />
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
          <ExpiryBanner key={k} show={k} n={e[k].n} href={stockHref({ tab: k, all: true })} />
        ))}
    </>
  );
}

// The cashier's end-of-day job (SAL-2, ADR 039): import the POS's Sale by item file.
function PosCard({ pos, tz }: { pos: NonNullable<Today['pos']>; tz: string }) {
  const href = `/menu/sales/import?node=${pos.outlet.id}&date=${pos.day}`;
  return (
    <section aria-label="Today's sales" className={card} data-testid="pos-card">
      <h2 className={cardTitle}>End of day</h2>
      {pos.last ? (
        <p className="mt-2 flex items-center gap-2 text-slate-700">
          <Icon name="check" className="size-5 text-emerald-700" />
          Sales imported at {formatTime(pos.last.at, tz)}: {pos.last.posted} items
          {pos.last.unmatched > 0 ? `, ${pos.last.unmatched} not matched yet` : ''}
        </p>
      ) : (
        <p className="mt-2 text-slate-700">Today&apos;s sales are not imported yet.</p>
      )}
      <Link
        href={href}
        className={`mt-3 flex min-h-13 items-center justify-center gap-2 rounded-xl text-lg font-semibold ${
          pos.last ? 'border border-brand-700 text-brand-700' : 'bg-brand-700 text-white'
        }`}
      >
        <Icon name="upload" />
        {pos.last ? 'Import again' : 'Import sales'}
      </Link>
    </section>
  );
}

// Dishes to sell first (INV-12, ADR 040): they use prep that expires by tomorrow.
function PushToday({ push, tz }: { push: Today['push']; tz: string }) {
  const dishes = [...new Map(push.map((p) => [p.menu_item_id, p])).values()];
  const uses = (id: string) => [
    ...new Set(push.filter((p) => p.menu_item_id === id).map((p) => p.item)),
  ];
  return (
    <section aria-label="Push today" className={card} data-testid="push-today">
      <h2 className={`${cardTitle} flex items-center gap-1.5`}>
        <Icon name="fire" className="size-4 text-amber-600" />
        Push today
      </h2>
      <ul className="mt-2 divide-y divide-slate-100">
        {dishes.slice(0, 8).map((d) => (
          <li key={d.menu_item_id} className="py-2" data-testid="push-dish">
            <span className="block font-semibold">{d.dish}</span>
            <span className="block text-sm text-slate-500">
              uses {uses(d.menu_item_id).join(', ')}, use by{' '}
              {formatDay(businessDate(d.expires_at, tz))}
            </span>
          </li>
        ))}
      </ul>
      {dishes.length > 8 && <p className="text-sm text-slate-500">and {dishes.length - 8} more</p>}
    </section>
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
              <span className="block font-semibold">{next.title}</span>
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
  const { shown, total } = today.approvals;
  if (total === 0) return null;
  return (
    <section aria-label="Waiting for you" className={card} data-testid="approvals-card">
      <div className="flex items-center justify-between">
        <h2 className={cardTitle}>Waiting for you</h2>
        <span className="rounded-full bg-rose-50 px-2 text-sm font-bold text-rose-700 tabular-nums">
          {total}
        </span>
      </div>
      {shown.length > 0 && (
        <ul className="mt-2 divide-y divide-slate-100">
          {shown.map((e) => (
            <InboxItem key={e.requestId} entry={e} compact />
          ))}
        </ul>
      )}
      {total > HOME_APPROVALS && (
        <Link href="/inbox" className="mt-2 block text-sm font-medium text-brand-700">
          See all {total}
        </Link>
      )}
    </section>
  );
}

const TONE_CHIP = { bad: 'bg-rose-50 text-rose-700', warn: 'bg-amber-50 text-amber-800' } as const;
const TONE_DOT = { bad: 'bg-rose-600', warn: 'bg-amber-500' } as const;

/** Do these first (UX-8): at most five lines, each with the one thing to do about it. */
function DoFirst({ items }: { items: ReturnType<typeof doFirst> }) {
  if (items.length === 0) return null;
  return (
    <section aria-label="Do these first" className={card} data-testid="dofirst-card">
      <h2 className={cardTitle}>Do these first</h2>
      <ul className="mt-2 divide-y divide-slate-100">
        {items.map((x) => (
          <li key={x.key} data-tone={x.tone} data-testid="dofirst-item">
            <Link href={x.href} className="flex min-h-13 items-center gap-3 py-2">
              <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${TONE_DOT[x.tone]}`} />
              <span className="min-w-0 flex-1">
                <span className="font-bold tabular-nums">{x.n}</span> {x.text}
              </span>
              <span
                className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${TONE_CHIP[x.tone]}`}
              >
                {x.action}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Every department, one line each, behind a tap (DB-2 order; UX-8). */
function Attention({ today }: { today: Today }) {
  const groups = today.attention ?? [];
  if (groups.length === 0) return null;
  return (
    <section aria-label="Needs attention" className={card} data-testid="attention-card">
      <details>
        <summary className="flex min-h-11 cursor-pointer items-center justify-between text-sm font-medium text-slate-700">
          <span className={cardTitle}>All departments ({groups.length})</span>
          <span className="underline">Show</span>
        </summary>
        <div className="mt-3 space-y-3">
          {groups.map((g) => (
            <section
              key={g.key}
              aria-label={g.label}
              className="space-y-1"
              data-testid="attention-group"
              data-tone={g.tone}
            >
              {/* one line per department: its name, a dot for the worst, then what is open */}
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <span aria-hidden className={`size-2.5 rounded-full ${TONE_DOT[g.tone]}`} />
                {g.label}
              </h3>
              <p className="flex flex-wrap gap-x-3 gap-y-1 pl-4 text-sm">
                {g.lines.map((a) => (
                  <Link
                    key={a.text}
                    href={a.href}
                    className="inline-flex min-h-8 items-center gap-1"
                  >
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
      </details>
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

/**
 * Outlets side by side for the last 7 days (R-4). Food, drinks, losses and people are each a
 * share of the outlet's total cost, so they add up to 100 (ADR 047); a dot per outlet is red
 * when food or people is worse than target (UX-6, UX-8), and the name opens its report.
 */
function League({
  league,
  targets,
}: {
  league: NonNullable<Today['league']>;
  targets: Record<TargetKey, number>;
}) {
  const cols = [
    { key: 'food_share', label: 'Food' },
    { key: 'drink_share', label: 'Drinks' },
    { key: 'losses_share', label: 'Losses' },
    { key: 'labour_pct', label: 'People' },
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
            <th scope="col" className="py-1 text-right font-medium">
              Sales
            </th>
            {cols.map((c) => (
              <th key={c.key} scope="col" className="py-1 pl-2 text-right font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {league.rows.map((r) => {
            const bad =
              vsTarget('food_pct', r.food_pct, targets).state === 'bad' ||
              vsTarget('labour_pct', r.labour_pct, targets).state === 'bad';
            return (
              <tr
                key={r.outlet_id}
                className="border-t border-slate-100"
                data-tone={bad ? 'bad' : 'ok'}
              >
                <th scope="row" className="max-w-28 py-2 text-left font-medium">
                  <Link
                    href={`/reports/outlet?node=${r.outlet_id}`}
                    className="flex min-h-11 items-center gap-1.5"
                  >
                    <span
                      aria-label={bad ? 'Over target' : 'On target'}
                      className={`inline-block size-2.5 shrink-0 rounded-full ${bad ? 'bg-rose-600' : 'bg-emerald-600'}`}
                    />
                    <span className="truncate">{r.name}</span>
                  </Link>
                </th>
                <td className="py-2 text-right">{formatMeasure('money', r.sales)}</td>
                {cols.map((c) => {
                  const v = r[c.key];
                  const worse =
                    c.key === 'labour_pct' && vsTarget(c.key, v, targets).state === 'bad';
                  return (
                    <td
                      key={c.key}
                      className={`py-2 pl-2 text-right ${worse ? 'font-bold text-rose-700' : ''}`}
                    >
                      {v === null ? '—' : formatMeasure('pct', v)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-500">
        Food, drinks, losses and people are shares of each outlet&apos;s total cost.
      </p>
      <Link
        href={`/reports/league?node=${league.place.id}&period=custom&from=${league.from}&to=${league.to}`}
        className="mt-3 flex items-center gap-1 text-sm font-medium text-brand-700"
      >
        All figures <Icon name="chevron" className="size-4" />
      </Link>
    </section>
  );
}
