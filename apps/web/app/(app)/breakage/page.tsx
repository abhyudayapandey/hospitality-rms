import Link from 'next/link';
import {
  BREAKAGE_REASON_WORDS,
  BROKEN_BY_WORDS,
  type BreakageReason,
  type BrokenBy,
} from '@outlet-ops/domain';
import { BackLink } from '@/components/back-link';
import { ItemThumb } from '@/components/item-thumb';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { breakageItems, breakageLog, breakageMonths, breakagePlaces } from '@/lib/breakage';
import { localToday } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { formatMoney, formatWhen } from '@/lib/format';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { formatQty } from '@/lib/qty';
import { BreakageForm } from './breakage-form';

// Breakage (ADR 093): a department records what broke; the month's log for the place, its
// total, then the last 12 months. A department head sees the whole outlet's.
const monthWords = (m: string) =>
  new Date(`${m}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

export default async function BreakagePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const places = await withUser(user.id, (tx) => breakagePlaces(tx));
  const asked = param(sp, 'place');
  const place =
    places.find((p) => isUuid(asked) && p.place_id === asked) ??
    places.find((p) => p.can_record) ??
    places[0];
  if (!place) {
    return (
      <div className="space-y-4">
        <BackLink />
        <h1 className="text-xl font-semibold">Breakage</h1>
        <Empty>You don&apos;t record or see breakage anywhere.</Empty>
      </div>
    );
  }
  const askedMonth = param(sp, 'month');
  const month = /^\d{4}-\d{2}-01$/.test(askedMonth ?? '')
    ? askedMonth
    : `${localToday().slice(0, 7)}-01`;
  const { log, months, items } = await withUser(user.id, async (tx) => ({
    log: await breakageLog(tx, place.place_id, month),
    months: await breakageMonths(tx, place.place_id),
    items: place.can_record && place.stores[0] ? await breakageItems(tx, place.stores[0].id) : [],
  }));
  const total = log.reduce((s, e) => s + Number(e.value), 0);
  const href = (p: string, m = month) => `/breakage?place=${p}&month=${m}`;
  return (
    <div className="space-y-4">
      <BackLink />
      <div>
        <h1 className="text-xl font-semibold">Breakage</h1>
        <p className="text-sm text-slate-600">
          {place.kind === 'department' ? `${place.name} · ${place.outlet}` : place.name}
        </p>
      </div>
      {places.length > 1 && (
        <nav aria-label="Where" className="flex flex-wrap gap-2">
          {places.map((p) => (
            <Link
              key={p.place_id}
              href={href(p.place_id)}
              aria-current={p.place_id === place.place_id ? 'page' : undefined}
              className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium ring-1 ${
                p.place_id === place.place_id
                  ? 'bg-brand-700 text-white ring-brand-700'
                  : 'bg-white text-slate-700 ring-slate-300'
              }`}
            >
              {p.kind === 'outlet' ? `All of ${p.name}` : p.name}
            </Link>
          ))}
        </nav>
      )}
      <section className="space-y-2">
        <h2 className="font-semibold">
          {monthWords(month)}{' '}
          <span className="text-sm font-normal text-slate-600" data-testid="breakage-total">
            {log.length} {log.length === 1 ? 'entry' : 'entries'} · {formatMoney(total)}
          </span>
        </h2>
        {log.length === 0 ? (
          <Empty>Nothing broken this month.</Empty>
        ) : (
          <ul
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="breakage-log"
          >
            {log.map((e) => (
              <li
                key={e.id}
                className="flex items-center gap-3 px-4 py-3 text-sm"
                data-testid="breakage-row"
              >
                <ItemThumb name={e.item} size="size-10" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {formatQty(e.qty, e.unit)} {e.item}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {BREAKAGE_REASON_WORDS[e.reason as BreakageReason]} ·{' '}
                    {e.person ?? BROKEN_BY_WORDS[e.broken_by as BrokenBy]}
                    {place.kind === 'outlet' && ` · ${e.place}`}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {formatWhen(e.broken_at)}
                    {e.recorded_by && `, recorded by ${e.recorded_by}`}
                    {e.note && ` · ${e.note}`}
                  </span>
                </span>
                <span className="shrink-0 font-medium tabular-nums">{formatMoney(e.value)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {months.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">By month</h2>
          <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            {months.map((m) => (
              <li key={m.month}>
                <Link
                  href={href(place.place_id, m.month)}
                  className="flex min-h-11 items-center justify-between px-4 py-2 text-sm"
                  data-testid="breakage-month"
                >
                  <span>{monthWords(m.month)}</span>
                  <span className="tabular-nums">
                    {m.entries} · {formatMoney(m.value)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {place.can_record && <BreakageForm place={place} initialItems={items} />}
    </div>
  );
}
