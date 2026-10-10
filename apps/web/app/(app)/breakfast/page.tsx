import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { Icon } from '@/components/icon';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { addDays, formatDay } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { breakfastDay, breakfastOutlets, rooms } from '@/lib/rooms';
import { BreakfastRoomForm, BreakfastTotals } from './breakfast-forms';

// Breakfast (ADR 094): the day's guests by mode, the totals front office gave and the rooms,
// for the kitchen and restaurant to cook and serve; front office and housekeeping change them.
// The rooms are tiles with their guests (ADR 104); a room is chosen by tapping its tile.
const MODE_WORDS = { in_room: 'In-room', buffet: 'Buffet' } as const;

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
  const tomorrow = addDays(outlet.today, 1);
  const day = param(sp, 'day') === tomorrow ? tomorrow : outlet.today;
  const modes = await withUser(user.id, (tx) => breakfastDay(tx, outlet.outlet_id, day));
  const canEdit = modes.some((m) => m.can_edit);
  const roomList = canEdit ? await withUser(user.id, (tx) => rooms(tx, outlet.outlet_id)) : [];
  const href = (d: string) => `/breakfast?outlet=${outlet.outlet_id}&day=${d}`;
  return (
    <div className="space-y-4">
      <BackLink />
      <div>
        <h1 className="text-xl font-semibold">Breakfast</h1>
        <p className="text-sm text-slate-600">{outlet.name}</p>
      </div>
      <nav aria-label="Day" className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
        {[
          [outlet.today, 'Today'],
          [tomorrow, 'Tomorrow'],
        ].map(([d, label]) => (
          <Link
            key={d}
            href={href(d!)}
            aria-current={d === day ? 'page' : undefined}
            className={`flex min-h-11 items-center justify-center rounded-md text-sm ${
              d === day ? 'bg-white font-semibold shadow-sm' : 'text-slate-600'
            }`}
          >
            {label}, {formatDay(d!)}
          </Link>
        ))}
      </nav>
      {modes.map((m) => (
        <section key={m.mode} className="space-y-2" data-testid={`breakfast-${m.mode}`}>
          <h2 className="flex items-baseline justify-between font-semibold">
            {MODE_WORDS[m.mode]}
            <span className="text-sm font-normal text-slate-600" data-testid="breakfast-total">
              {m.total === null ? 'no total yet' : `${m.total} guests`}
              {m.rooms > 0 && ` · ${m.rooms} by room`}
            </span>
          </h2>
          {m.room_list.length > 0 && (
            <ul className="grid grid-cols-4 gap-2">
              {m.room_list.map((r) => (
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
                  {r.note && <span className="line-clamp-2 text-xs text-slate-500">{r.note}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {canEdit && (
        <>
          <BreakfastTotals
            outlet={outlet.outlet_id}
            day={day}
            totals={Object.fromEntries(modes.map((m) => [m.mode, m.total]))}
          />
          <BreakfastRoomForm
            day={day}
            rooms={roomList.map((r) => ({
              room_id: r.room_id,
              number: r.number,
              floor: r.floor,
            }))}
          />
        </>
      )}
    </div>
  );
}
