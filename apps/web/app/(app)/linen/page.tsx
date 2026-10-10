import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { ViewTabs } from '@/components/view-tabs';
import { requireUser } from '@/lib/auth/server';
import { businessDate, formatDay } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { laundry, linenItems, linenPlaces, uniforms } from '@/lib/linen';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { LaundryForm, ReturnUniform, UniformForm } from './linen-forms';

// Linen & uniforms (ADR 094): the laundry exchange of a place, day by day, with what is still
// at the laundry; and the uniforms its people hold. Linen in a store is counted in the usual
// month-end stock check.
export default async function LinenPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const places = await withUser(user.id, (tx) => linenPlaces(tx));
  const asked = param(sp, 'place');
  const place =
    places.find((p) => isUuid(asked) && p.place_id === asked) ??
    places.find((p) => p.kind === 'department') ??
    places[0];
  if (!place) {
    return (
      <div className="space-y-4">
        <BackLink />
        <h1 className="text-xl font-semibold">Linen & uniforms</h1>
        <Empty>You don&apos;t keep linen or uniforms anywhere.</Empty>
      </div>
    );
  }
  const view = param(sp, 'view') === 'uniforms' ? 'uniforms' : 'laundry';
  // the 04:00 business day (ADR 057), as ops.record_laundry checks it
  const day = businessDate(new Date());
  const data = await withUser(user.id, async (tx) =>
    view === 'laundry'
      ? { rows: await laundry(tx, place.place_id), items: await linenItems(tx, place.place_id) }
      : { held: await uniforms(tx, place.place_id) },
  );
  const href = (p: string, v = view) => `/linen?place=${p}&view=${v}`;
  const atLaundry = data.rows
    ? [...new Map(data.rows.map((r) => [r.item_id, r])).values()].filter((r) => r.at_laundry !== 0)
    : [];
  const days = data.rows ? [...new Set(data.rows.map((r) => r.day))] : [];
  return (
    <div className="space-y-4">
      <BackLink />
      <div>
        <h1 className="text-xl font-semibold">Linen & uniforms</h1>
        <p className="text-sm text-slate-600">{place.name}</p>
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
              {p.name}
            </Link>
          ))}
        </nav>
      )}
      <ViewTabs
        label="Linen"
        current={view}
        tabs={[
          { key: 'laundry', label: 'Laundry', href: href(place.place_id, 'laundry') },
          { key: 'uniforms', label: 'Uniforms', href: href(place.place_id, 'uniforms') },
        ]}
      />
      {data.rows && (
        <>
          <section className="space-y-2">
            <h2 className="font-semibold">At the laundry now</h2>
            {atLaundry.length === 0 ? (
              <Empty>Nothing is at the laundry.</Empty>
            ) : (
              <ul
                className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
                data-testid="at-laundry"
              >
                {atLaundry.map((r) => (
                  <li key={r.item_id} className="flex justify-between px-4 py-2 text-sm">
                    <span>{r.item}</span>
                    <span className="tabular-nums" data-testid="at-laundry-qty">
                      {r.at_laundry}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {days.slice(0, 14).map((d) => (
            <section key={d} className="space-y-1">
              <h3 className="text-sm font-semibold text-slate-500">{formatDay(d)}</h3>
              <ul className="divide-y divide-slate-100 rounded-xl bg-white text-sm ring-1 ring-slate-200">
                {data.rows
                  .filter((r) => r.day === d)
                  .map((r) => (
                    <li key={r.item_id} className="flex justify-between px-4 py-2">
                      <span>{r.item}</span>
                      <span className="tabular-nums">
                        sent {r.sent} · back {r.received}
                      </span>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
          {place.can_edit && <LaundryForm place={place.place_id} day={day} items={data.items} />}
        </>
      )}
      {data.held && (
        <>
          {data.held.length === 0 ? (
            <Empty>No uniforms issued here.</Empty>
          ) : (
            <ul
              className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
              data-testid="uniforms"
            >
              {data.held.map((u) => (
                <li
                  key={u.id}
                  className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
                  data-testid="uniform"
                >
                  <span className="min-w-0">
                    <span className="block font-medium">{u.person}</span>
                    <span className="block text-xs text-slate-500">
                      {u.qty} × {u.item}
                      {u.size && ` (${u.size})`} · issued {formatWhen(u.issued_at)}
                      {u.returned_at && ` · returned ${formatWhen(u.returned_at)}`}
                    </span>
                  </span>
                  {place.can_edit && !u.returned_at && <ReturnUniform id={u.id} />}
                </li>
              ))}
            </ul>
          )}
          {place.can_edit && <UniformForm place={place.place_id} people={place.people} />}
        </>
      )}
    </div>
  );
}
