import Link from 'next/link';
import { Empty } from '@/components/messages';
import { ViewTabs } from '@/components/view-tabs';
import { requireUser } from '@/lib/auth/server';
import { addDays, businessDate } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { formatMoney, formatWhen } from '@/lib/format';
import {
  isMinibarTab,
  minibarPlaces,
  minibarRooms,
  minibarToCharge,
  minibarUsage,
  usedWords,
  type MinibarTab,
} from '@/lib/minibar';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { formatQty } from '@/lib/qty';
import { ChargedButton } from './charged-button';

// The rooms' minibars (ADR 072): every room with when it was last checked, what is still to
// be added to guests' bills, and what the minibars sold. One screen, three tabs (ADR 048).

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
  const tab: MinibarTab = isMinibarTab(raw) ? raw : 'rooms';
  const days = param(sp, 'days') === '30' ? 30 : 7;
  const today = businessDate(new Date());
  const { rooms, charge, usage } = await withUser(user.id, async (tx) => ({
    rooms: await minibarRooms(tx, place.outlet_id),
    charge: await minibarToCharge(tx, place.outlet_id),
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
          {place.outlet}: {checkedToday} of {rooms.length} rooms checked today
          {toCharge > 0 && ` · ${formatMoney(toCharge)} to add to bills`}
        </p>
      </div>
      <ViewTabs
        label="Minibar view"
        current={tab}
        tabs={[
          { key: 'rooms', label: 'Rooms', count: rooms.length, href: href('rooms') },
          { key: 'charge', label: 'To charge', count: charge.length, href: href('charge') },
          { key: 'usage', label: 'Sold', href: href('usage') },
        ]}
      />

      {tab === 'rooms' && (
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {rooms.map((r) => (
            <li key={r.id} data-testid="minibar-room" data-room={r.number}>
              <Link
                href={`/minibar/${r.id}`}
                className="flex min-h-14 items-center justify-between gap-3 px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="block font-medium">
                    Room {r.number}
                    {r.room_type && (
                      <span className="font-normal text-slate-500"> · {r.room_type}</span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {!r.set_name
                      ? 'No minibar'
                      : r.last_checked_at
                        ? `Checked ${formatWhen(r.last_checked_at)}${r.last_checked_by ? ` by ${r.last_checked_by}` : ''}`
                        : 'Not checked yet'}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1 text-xs">
                  {r.checked_today && (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-800">
                      Checked today
                    </span>
                  )}
                  {Number(r.to_charge) > 0 && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-800">
                      {formatMoney(r.to_charge)} to charge
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

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
                <p className="text-sm text-slate-600">{usedWords(c.used)}</p>
                <p className="text-xs text-slate-500">
                  Checked {formatWhen(c.checked_at)}
                  {c.checked_by && ` by ${c.checked_by}`}
                </p>
                {place.can_check && <ChargedButton id={c.id} />}
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
