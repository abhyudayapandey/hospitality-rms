import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { Icon } from '@/components/icon';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { addDays, formatDay, isIsoDate } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { breakfastDay, breakfastOutlets, rooms } from '@/lib/rooms';
import { BreakfastForm } from './breakfast-forms';

// Breakfast (ADR 094, 110): the next breakfast first. Before the outlet's breakfast ends (12:00
// unless the company says otherwise) that is today's, after it tomorrow's. A breakfast that has
// been served is read only, and any earlier day can be opened for a look back. Buffet comes
// first, with room numbers only when wanted; in-room is the rooms and their guests.
const MODES = [
  ['buffet', 'Buffet'],
  ['in_room', 'In-room'],
] as const;

export default async function BreakfastPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const outlets = await withUser(user.id, (tx) => breakfastOutlets(tx));
  const asked = param(sp, 'outlet');
  const outlet = outlets.find((o) => isUuid(asked) && o.outlet_id === asked) ?? outlets[0];
  if (!outlet) {
    return (
      <div className="space-y-4">
        <BackLink />
        <h1 className="text-xl font-semibold">Breakfast</h1>
        <Empty>You don&apos;t see any hotel&apos;s breakfast.</Empty>
      </div>
    );
  }
  const next = outlet.next_day;
  const askedDay = param(sp, 'day');
  const day = askedDay && isIsoDate(askedDay) ? askedDay : next;
  const modes = await withUser(user.id, (tx) => breakfastDay(tx, outlet.outlet_id, day));
  const mayChange = modes.some((m) => m.can_edit);
  const open = mayChange && day >= next && day <= addDays(next, 7);
  const roomList = open ? await withUser(user.id, (tx) => rooms(tx, outlet.outlet_id)) : [];
  const href = (d: string) => `/breakfast?outlet=${outlet.outlet_id}&day=${d}`;
  const served = day < next;
  const word = (d: string) =>
    d === outlet.today ? 'Today' : d === addDays(outlet.today, 1) ? 'Tomorrow' : null;
  // the chips: the last one served (when today's is over), the next two, then any other day
  const chips = [...(next > outlet.today ? [outlet.today] : []), next, addDays(next, 1)];
  const byMode = Object.fromEntries(modes.map((m) => [m.mode, m]));
  return (
    <div className="space-y-4">
      <BackLink />
      <div>
        <h1 className="text-xl font-semibold">Breakfast</h1>
        <p className="text-sm text-slate-600">{outlet.name}</p>
      </div>
      <nav aria-label="Day" className="flex flex-wrap gap-2">
        {chips.map((d) => (
          <Link
            key={d}
            href={href(d)}
            aria-current={d === day ? 'page' : undefined}
            data-testid="breakfast-day"
            className={`flex min-h-11 items-center rounded-full px-4 text-sm ring-1 ${
              d === day
                ? 'bg-brand-700 font-semibold text-white ring-brand-700'
                : d < next
                  ? 'text-slate-500 ring-slate-300'
                  : 'bg-white text-slate-800 ring-slate-300'
            }`}
          >
            {[word(d), formatDay(d)].filter(Boolean).join(', ')}
            {d < next && ' · served'}
          </Link>
        ))}
        <details className="contents">
          <summary
            className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-full bg-white px-4 text-sm text-slate-800 ring-1 ring-slate-300"
            data-testid="breakfast-other-day"
          >
            <Icon name="calendar" className="size-4" />
            Other day
          </summary>
          <form method="get" className="flex w-full items-center gap-2">
            <input type="hidden" name="outlet" value={outlet.outlet_id} />
            <input
              type="date"
              name="day"
              aria-label="Day"
              defaultValue={day}
              max={addDays(next, 7)}
              className="min-h-11 flex-1 rounded-xl border border-slate-300 bg-white px-3"
            />
            <button
              type="submit"
              className="min-h-11 rounded-xl px-4 font-semibold ring-1 ring-slate-300"
            >
              Open
            </button>
          </form>
        </details>
      </nav>
      {day === next && next > outlet.today && (
        <p className="text-sm text-slate-600" data-testid="breakfast-why-tomorrow">
          Today&apos;s breakfast is over, so this opens on tomorrow.
        </p>
      )}
      {served && (
        <p className="text-sm text-slate-600" data-testid="breakfast-served">
          Served. This is what was given; it can&apos;t be changed.
        </p>
      )}
      {open ? (
        <BreakfastForm
          key={day}
          outlet={outlet.outlet_id}
          day={day}
          saveLabel={
            word(day) === 'Today'
              ? "Save today's breakfast"
              : word(day) === 'Tomorrow'
                ? "Save tomorrow's breakfast"
                : `Save ${formatDay(day)}`
          }
          modes={MODES.map(([m]) => ({
            mode: m,
            total: byMode[m]?.total ?? null,
            rooms: (byMode[m]?.room_list ?? []).map((r) => ({
              room_id: r.room_id,
              number: r.number,
              guests: r.guests,
              note: r.note ?? '',
            })),
          }))}
          rooms={roomList.map((r) => ({ room_id: r.room_id, number: r.number, floor: r.floor }))}
        />
      ) : (
        MODES.map(([m, label]) => {
          const mode = byMode[m];
          return (
            <section key={m} className="space-y-2" data-testid={`breakfast-${m}`}>
              <h2 className="flex items-baseline justify-between font-semibold">
                <span className="inline-flex items-center gap-2">
                  <Icon name={m === 'in_room' ? 'bed' : 'plate'} className="size-5" />
                  {label}
                </span>
                <span className="text-sm font-normal text-slate-600" data-testid="breakfast-total">
                  {mode?.total == null ? 'no total yet' : `${mode.total} guests`}
                  {mode && mode.rooms > 0 && ` · ${mode.rooms} by room`}
                </span>
              </h2>
              {mode && mode.room_list.length > 0 && (
                <ul className="grid grid-cols-4 gap-2">
                  {mode.room_list.map((r) => (
                    <li
                      key={r.room_id}
                      className="flex min-h-18 flex-col items-center justify-center rounded-xl bg-white px-1 py-2 text-center ring-1 ring-slate-200"
                      data-testid="breakfast-room"
                    >
                      <span className="text-lg leading-tight font-bold tabular-nums">
                        <span className="sr-only">Room </span>
                        {r.number}
                      </span>
                      <span className="inline-flex items-center gap-0.5 text-sm font-semibold text-brand-700 tabular-nums">
                        <Icon name="user" className="size-4" />×{r.guests}
                      </span>
                      {r.note && (
                        <span className="line-clamp-2 text-xs text-slate-500">{r.note}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
