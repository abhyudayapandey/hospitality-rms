import Link from 'next/link';
import { Empty } from '@/components/messages';
import { ViewTabs } from '@/components/view-tabs';
import { requireUser } from '@/lib/auth/server';
import { addDays, businessDate } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { formatMoney, formatWhen } from '@/lib/format';
import { Icon } from '@/components/icon';
import { byFloor, floorName } from '@/lib/rooms-view';
import {
  isMinibarTab,
  minibarPlaces,
  minibarRooms,
  minibarToCharge,
  minibarUsage,
  type MinibarRoomRow,
  type MinibarTab,
} from '@/lib/minibar';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { formatQty } from '@/lib/qty';
import { ChargedButton } from './charged-button';
import { UsedLines } from './used-lines';

// The rooms' minibars (ADR 072, 104): every room as a tile, those due a check today first;
// what is still to be added to guests' bills (for whoever bills them: the front desk and the
// managers); and what was charged to guests. One screen, its tabs (ADR 048). When a room was
// last checked, and by whom, is on the room's own page.

const PERIODS = [7, 30] as const;

export default async function MinibarPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const places = await withUser(user.id, (tx) => minibarPlaces(tx));
  const asked = param(sp, 'outlet');
  const place = places.find((p) => isUuid(asked) && p.outlet_id === asked) ?? places[0];
  if (!place) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Minibars</h1>
        <Empty>You don&apos;t look after any rooms&apos; minibars.</Empty>
      </div>
    );
  }
  const raw = param(sp, 'tab');
  const askedTab: MinibarTab = isMinibarTab(raw) ? raw : 'rooms';
  const tab: MinibarTab = askedTab === 'charge' && !place.bills ? 'rooms' : askedTab;
  const days = param(sp, 'days') === '30' ? 30 : 7;
  const today = businessDate(new Date());
  const { rooms, charge, usage } = await withUser(user.id, async (tx) => ({
    rooms: await minibarRooms(tx, place.outlet_id),
    charge: place.bills ? await minibarToCharge(tx, place.outlet_id) : [],
    usage:
      tab === 'usage'
        ? await minibarUsage(tx, place.outlet_id, addDays(today, 1 - days), today)
        : [],
  }));
  const href = (t: MinibarTab, extra = '') => `/minibar?outlet=${place.outlet_id}&tab=${t}${extra}`;
  const checkedToday = rooms.filter((r) => r.checked_today).length;
  const toCharge = charge.reduce((s, c) => s + Number(c.charge), 0);

  return (
    <div className="space-y-4">
      {places.length > 1 && (
        <nav aria-label="Outlet" className="flex flex-wrap gap-2">
          {places.map((p) => (
            <Link
              key={p.outlet_id}
              href={`/minibar?outlet=${p.outlet_id}`}
              aria-current={p.outlet_id === place.outlet_id ? 'page' : undefined}
              className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium ring-1 ${
                p.outlet_id === place.outlet_id
                  ? 'bg-brand-700 text-white ring-brand-700'
                  : 'bg-white text-slate-700 ring-slate-300'
              }`}
            >
              {p.outlet}
            </Link>
          ))}
        </nav>
      )}
      <div>
        <h1 className="text-xl font-semibold">Minibars</h1>
        <p className="text-sm text-slate-600" data-testid="minibar-summary">
          {checkedToday} of {rooms.length} rooms checked today
          {place.bills && toCharge > 0 && ` · ${formatMoney(toCharge)} to add to bills`}
        </p>
      </div>
      <ViewTabs
        label="Minibar view"
        current={tab}
        tabs={[
          { key: 'rooms', label: 'Rooms', count: rooms.length, href: href('rooms') },
          // the rupees to add to bills are for whoever bills them (ADR 104)
          ...(place.bills
            ? [{ key: 'charge', label: 'To charge', count: charge.length, href: href('charge') }]
            : []),
          { key: 'usage', label: 'Charged to guests', href: href('usage') },
        ]}
      />

      {tab === 'rooms' && <MinibarTiles rooms={rooms} bills={place.bills} />}

      {tab === 'charge' &&
        (charge.length === 0 ? (
          <Empty>Every minibar charge is on the guest&apos;s bill.</Empty>
        ) : (
          <ul className="space-y-2" data-testid="minibar-to-charge">
            {charge.map((c) => (
              <li
                key={c.id}
                data-testid="minibar-charge"
                data-room={c.room}
                className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-200"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">Room {c.room}</span>
                  <span className="font-semibold">{formatMoney(c.charge)}</span>
                </div>
                <UsedLines used={c.used} prices />
                <p className="text-xs text-slate-500">
                  Checked {formatWhen(c.checked_at)}
                  {c.checked_by && ` by ${c.checked_by}`}
                </p>
                <ChargedButton id={c.id} />
              </li>
            ))}
          </ul>
        ))}

      {tab === 'usage' && (
        <div className="space-y-3">
          <nav aria-label="Period" className="flex gap-2">
            {PERIODS.map((d) => (
              <Link
                key={d}
                href={href('usage', `&days=${d}`)}
                aria-current={d === days ? 'page' : undefined}
                className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium ring-1 ${
                  d === days
                    ? 'bg-brand-700 text-white ring-brand-700'
                    : 'bg-white text-slate-700 ring-slate-300'
                }`}
              >
                Last {d} days
              </Link>
            ))}
          </nav>
          {usage.length === 0 ? (
            <Empty>Nothing was taken from the minibars in these days.</Empty>
          ) : (
            <>
              <p className="text-sm text-slate-600" data-testid="minibar-usage-total">
                {formatMoney(usage.reduce((s, u) => s + Number(u.revenue), 0))} sold, costing{' '}
                {formatMoney(usage.reduce((s, u) => s + Number(u.cost), 0))}
              </p>
              <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
                {usage.map((u) => (
                  <li
                    key={u.item_id}
                    data-testid="minibar-usage"
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{u.item}</span>
                      <span className="block text-xs text-slate-500">
                        {formatQty(u.used, u.unit)} from {u.rooms} room{u.rooms === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-sm">
                      <span className="block font-semibold">{formatMoney(u.revenue)}</span>
                      <span className="block text-xs text-slate-500">
                        cost {formatMoney(u.cost)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** "₹1,050": a tile is narrow, so whole rupees. */
function rupees(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/**
 * The rooms as tiles (ADR 104): those due a check today first, then every other room floor by
 * floor. Green with a tick: checked today; amber: due; faded: no minibar. Whoever bills them
 * sees what is still to charge on the tile.
 */
function MinibarTiles({ rooms, bills }: { rooms: MinibarRoomRow[]; bills: boolean }) {
  const due = rooms.filter((r) => r.due_today);
  const rest = rooms.filter((r) => !r.due_today);
  const tile = (r: MinibarRoomRow) => {
    const charge = Number(r.to_charge);
    const tone = !r.set_name
      ? 'bg-slate-50 text-slate-500 ring-slate-200'
      : r.checked_today
        ? 'bg-emerald-50 text-emerald-800 ring-emerald-300'
        : r.due_today
          ? 'bg-amber-50 text-amber-800 ring-amber-300'
          : 'bg-white text-slate-800 ring-slate-200';
    const word = !r.set_name
      ? 'no minibar'
      : r.checked_today
        ? 'checked today'
        : r.due_today
          ? 'due today'
          : 'not due';
    return (
      <li key={r.id} data-testid="minibar-room" data-room={r.number} data-due={r.due_today}>
        <Link
          href={`/minibar/${r.id}`}
          aria-label={`Room ${r.number}, ${word}${bills && charge > 0 ? `, ${rupees(charge)} to charge` : ''}`}
          className={`flex min-h-18 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-2 ring-1 ${tone}`}
        >
          {r.checked_today ? (
            <Icon name="check" className="size-5" />
          ) : r.set_name ? (
            <Icon name="fridge" className="size-5" />
          ) : (
            <span className="size-5" aria-hidden />
          )}
          <span className="text-lg leading-tight font-bold tabular-nums">
            <span className="sr-only">Room </span>
            {r.number}
          </span>
          {bills && charge > 0 && (
            <span
              className="rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-900 tabular-nums"
              data-testid="minibar-room-charge"
            >
              {rupees(charge)}
            </span>
          )}
        </Link>
      </li>
    );
  };
  return (
    <div className="space-y-4">
      <ul
        className="flex flex-wrap gap-3 text-xs text-slate-600"
        aria-label="What the colours mean"
      >
        <li className="inline-flex items-center gap-1">
          <span aria-hidden className="size-3 rounded-sm bg-amber-300" /> due today
        </li>
        <li className="inline-flex items-center gap-1">
          <span aria-hidden className="size-3 rounded-sm bg-emerald-300" /> checked today
        </li>
      </ul>
      {due.length > 0 && (
        <section aria-label="Due today" className="space-y-2" data-testid="minibar-due">
          <h2 className="text-sm font-semibold text-amber-800">Due today ({due.length})</h2>
          <ul className="grid grid-cols-4 gap-2">{due.map(tile)}</ul>
        </section>
      )}
      {byFloor(rest).map((f, _, all) => (
        <section key={f.floor} aria-label={floorName(f.floor)} className="space-y-2">
          {(all.length > 1 || due.length > 0) && (
            <h2 className="text-sm font-semibold text-slate-500">
              {due.length > 0 && all.length === 1 ? 'Other rooms' : floorName(f.floor)}
            </h2>
          )}
          <ul className="grid grid-cols-4 gap-2">{f.rooms.map(tile)}</ul>
        </section>
      ))}
    </div>
  );
}
