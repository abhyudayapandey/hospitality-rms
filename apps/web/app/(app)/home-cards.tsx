import Link from 'next/link';
import { Icon } from '@/components/icon';
import { addDays, formatDay, formatSpan, localDate } from '@/lib/dates';
import { formatMoney } from '@/lib/format';
import type {
  HomeBreakfast,
  HomeEvent,
  HomeMinibar,
  HomeRooms,
  HomeTomorrow,
} from '@/lib/home-work';
import { usedWords } from '@/lib/minibar';
import { ChargedButton } from './minibar/charged-button';
import { RoomGrid, RoomLegend } from './rooms/status-picker';

// A person's own job on Home (ADR 113): their rooms, the minibar bills to post, the next
// breakfast, the events coming up and, in the evening, tomorrow's roster. Each card opens the
// screen it comes from; none decides access.

const card = 'block rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200';
const cardTitle = 'text-xs font-semibold tracking-wide text-slate-500 uppercase';
const more = 'mt-3 flex items-center gap-1 text-sm font-medium text-brand-700';

/**
 * My rooms (ADR 111, 113): the rooms given to me today, tapped to change their status, with
 * the rest one tap away. Without rooms of my own: every room's status, as a board.
 */
export function RoomsCard({ rooms }: { rooms: HomeRooms }) {
  const href = `/rooms?outlet=${rooms.outlet}`;
  if (rooms.mine.length > 0) {
    const ready = rooms.mine.filter((r) => r.status === 'VC').length;
    return (
      <section aria-label="Your rooms" className={`${card} space-y-3`} data-testid="home-rooms">
        <h2 className={`${cardTitle} flex items-baseline justify-between`}>
          <span>Your rooms ({rooms.mine.length})</span>
          <span className="normal-case">{ready} clean</span>
        </h2>
        <RoomGrid rooms={rooms.mine} />
        <Link href={href} className={more}>
          All rooms <Icon name="chevron" className="size-4" />
        </Link>
      </section>
    );
  }
  if (rooms.all.length === 0) return null;
  return (
    <section aria-label="Rooms now" className={`${card} space-y-3`} data-testid="home-rooms">
      <h2 className={cardTitle}>Rooms now · {rooms.all.length}</h2>
      <RoomLegend rooms={rooms.all} />
      <div className="flex flex-wrap gap-x-4">
        <Link href={href} className={more}>
          Open rooms <Icon name="chevron" className="size-4" />
        </Link>
        {rooms.gives && (
          <Link
            href={`/rooms/give?outlet=${rooms.outlet}`}
            className={more}
            data-testid="home-give-rooms"
          >
            <Icon name="people" className="size-4" /> Give rooms
          </Link>
        )}
      </div>
    </section>
  );
}

/** The front desk's minibar bills (ADR 104), or the attendant's minibars still to check. */
export function MinibarCard({ minibar }: { minibar: HomeMinibar }) {
  const href = `/minibar?outlet=${minibar.outlet}`;
  if (minibar.charge) {
    const rows = minibar.charge;
    if (rows.length === 0) return null;
    return (
      <section aria-label="Minibar charges to post" className={card} data-testid="home-minibar">
        <h2 className={`${cardTitle} flex items-baseline justify-between`}>
          <span>Minibar charges to post</span>
          <span className="rounded-full bg-amber-50 px-2 text-sm font-bold text-amber-800 tabular-nums">
            {rows.length}
          </span>
        </h2>
        <ul className="mt-2 divide-y divide-slate-100">
          {rows.slice(0, 3).map((r) => (
            <li key={r.id} className="space-y-2 py-2" data-testid="home-charge">
              <p className="flex items-baseline justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-bold tabular-nums">Room {r.room}</span>{' '}
                  <span className="text-sm text-slate-600">{usedWords(r.used)}</span>
                </span>
                <span className="shrink-0 font-semibold tabular-nums">{formatMoney(r.charge)}</span>
              </p>
              <ChargedButton id={r.id} />
            </li>
          ))}
        </ul>
        {rows.length > 3 && (
          <Link href={`${href}&tab=charge`} className={more}>
            {rows.length - 3} more <Icon name="chevron" className="size-4" />
          </Link>
        )}
      </section>
    );
  }
  const due = minibar.check ?? [];
  if (due.length === 0) return null;
  const mine = due.filter((r) => r.mine);
  const shown = (mine.length > 0 ? mine : due).slice(0, 8);
  return (
    <Link
      href={href}
      aria-label="Minibars to check"
      className={`${card} flex items-center gap-3`}
      data-testid="home-minibar"
    >
      <Icon name="fridge" className="size-8 shrink-0 text-brand-700" />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">
          {mine.length > 0
            ? `${mine.length} of your minibars to check`
            : `${due.length} minibars to check`}
        </span>
        <span className="block truncate text-sm text-slate-500 tabular-nums">
          {shown.map((r) => r.number).join(', ')}
          {(mine.length > 0 ? mine : due).length > shown.length && ' …'}
        </span>
      </span>
      <Icon name="chevron" className="size-5 shrink-0 text-slate-400" />
    </Link>
  );
}

/** The next breakfast (ADR 110): its guests, which opens Breakfast on that day. */
export function BreakfastCard({ breakfast: b }: { breakfast: HomeBreakfast }) {
  const word =
    b.day === b.today ? 'today' : b.day === addDays(b.today, 1) ? 'tomorrow' : formatDay(b.day);
  const none = b.buffet === null && b.inRoom === null;
  return (
    <Link
      href={`/breakfast?outlet=${b.outlet}&day=${b.day}`}
      aria-label={`Breakfast ${word}`}
      className={`${card} flex items-center gap-3`}
      data-testid="home-breakfast"
    >
      <Icon name="plate" className="size-8 shrink-0 text-brand-700" />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">Breakfast {word}</span>
        <span className="block text-sm text-slate-600 tabular-nums">
          {none
            ? 'No guests given yet'
            : [
                b.buffet !== null ? `Buffet ${b.buffet}` : null,
                b.inRoom !== null
                  ? `In-room ${b.inRoom}${b.rooms > 0 ? ` (${b.rooms} ${b.rooms === 1 ? 'room' : 'rooms'})` : ''}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
        </span>
      </span>
      <span className="shrink-0 text-sm font-semibold text-brand-700">
        {b.canEdit ? (none ? 'Add' : 'Change') : 'See'}
      </span>
    </Link>
  );
}

/** Events in the next seven days (ADR 113): covers, and the people rostered against needed. */
export function EventsCard({ events, tz }: { events: HomeEvent[]; tz: string }) {
  return (
    <section aria-label="Events" className={card} data-testid="home-events">
      <h2 className={cardTitle}>Events · next 7 days</h2>
      <ul className="mt-2 divide-y divide-slate-100">
        {events.map((e) => {
          const short = e.needed > 0 && e.rostered < e.needed;
          return (
            <li key={e.id}>
              <Link
                href={`/events/${e.id}?node=${e.node}`}
                className="flex min-h-13 items-center gap-3 py-2"
                data-testid="home-event"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{e.name}</span>
                  <span className="block text-sm text-slate-500 tabular-nums">
                    {formatDay(localDate(e.starts_at, tz))} ·{' '}
                    {formatSpan(e.starts_at, e.ends_at, tz)} · {e.covers} covers
                  </span>
                </span>
                {e.needed > 0 && (
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums ${
                      short ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'
                    }`}
                    data-testid="home-event-staff"
                  >
                    {e.rostered} of {e.needed} rostered
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** From the evening (ADR 112): tomorrow's roster where they build it, and what is not filled. */
export function TomorrowCard({ tomorrow: t }: { tomorrow: HomeTomorrow }) {
  const open = t.needed - t.rostered;
  return (
    <section aria-label="Tomorrow" className={card} data-testid="home-tomorrow">
      <h2 className={cardTitle}>Tomorrow · {formatDay(t.day)}</h2>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Link href={t.href} className="block rounded-xl p-3 ring-1 ring-slate-200">
          <span className="block text-xs text-slate-500">Rostered</span>
          <span className="block text-xl font-bold tabular-nums">
            {t.rostered} of {t.needed}
          </span>
        </Link>
        <Link
          href={t.href}
          className={`block rounded-xl p-3 ring-1 ${open > 0 ? 'bg-amber-50 ring-amber-300' : 'ring-slate-200'}`}
          data-testid="home-tomorrow-open"
        >
          <span className="block text-xs text-slate-500">Shifts not filled</span>
          <span className="block text-xl font-bold tabular-nums">
            {open}
            {open > 0 && <span className="ml-2 text-sm font-semibold text-amber-800">Fill</span>}
          </span>
        </Link>
      </div>
    </section>
  );
}
