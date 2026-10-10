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
import { ReceiveForm, ReturnUniform, SendForm, UniformForm } from './linen-forms';

// Linen & uniforms (ADR 094, 113): sending to the laundry and taking back are two moments, so
// two tabs: Send asks only for what goes out; Receive lists what is out, with a − / + for what
// came back. The days before fold away under them. Uniforms are the third tab. Linen in a store
// is counted in the usual month-end stock check.
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
  const asks = param(sp, 'view');
  const view = asks === 'uniforms' ? 'uniforms' : asks === 'receive' ? 'receive' : 'send';
  // the 04:00 business day (ADR 057), as ops.record_laundry checks it
  const day = businessDate(new Date());
  const data = await withUser(user.id, async (tx) =>
    view !== 'uniforms'
      ? { rows: await laundry(tx, place.place_id), items: await linenItems(tx, place.place_id) }
      : { held: await uniforms(tx, place.place_id) },
  );
  const href = (p: string, v = view) => `/linen?place=${p}&view=${v}`;
  const atLaundry = data.rows
    ? [...new Map(data.rows.map((r) => [r.item_id, r])).values()].filter((r) => r.at_laundry !== 0)
    : [];
  const days = data.rows ? [...new Set(data.rows.map((r) => r.day))] : [];
  // the last day each item went out: "since Thu"
  const since = (item: string) => {
    const d = data.rows?.find((r) => r.item_id === item && r.sent > 0)?.day;
    return d ? formatDay(d) : null;
  };
  const today = (data.rows ?? [])
    .filter((r) => r.day === day)
    .map((r) => ({ item_id: r.item_id, sent: r.sent, received: r.received }));
  const out = atLaundry
    .filter((r) => r.at_laundry > 0)
    .map((r) => ({
      item_id: r.item_id,
      name: r.item,
      at_laundry: r.at_laundry,
      since: since(r.item_id),
    }));
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
          { key: 'send', label: 'Send', href: href(place.place_id, 'send') },
          {
            key: 'receive',
            label: out.length > 0 ? `Receive (${out.length} out)` : 'Receive',
            href: href(place.place_id, 'receive'),
          },
          { key: 'uniforms', label: 'Uniforms', href: href(place.place_id, 'uniforms') },
        ]}
      />
      {data.rows && view === 'send' && place.can_edit && (
        <SendForm place={place.place_id} day={day} items={data.items} today={today} />
      )}
      {data.rows && view === 'receive' && (
        <section className="space-y-2">
          {out.length === 0 ? (
            <Empty>Nothing is at the laundry.</Empty>
          ) : place.can_edit ? (
            <ReceiveForm place={place.place_id} day={day} out={out} today={today} />
          ) : (
            <ul
              className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
              data-testid="at-laundry"
            >
              {out.map((r) => (
                <li key={r.item_id} className="flex justify-between gap-3 px-4 py-2 text-sm">
                  <span className="min-w-0 break-words">{r.name}</span>
                  <span className="shrink-0 tabular-nums" data-testid="at-laundry-qty">
                    {r.at_laundry}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {data.rows && days.length > 0 && (
        <details className="space-y-2" data-testid="laundry-days">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-slate-500">
            Days before ({Math.min(days.length, 14)})
          </summary>
          {days.slice(0, 14).map((d) => (
            <section key={d} className="space-y-1">
              <h3 className="text-sm font-semibold text-slate-500">{formatDay(d)}</h3>
              <ul className="divide-y divide-slate-100 rounded-xl bg-white text-sm ring-1 ring-slate-200">
                {data.rows
                  .filter((r) => r.day === d)
                  .map((r) => (
                    <li key={r.item_id} className="flex justify-between gap-3 px-4 py-2">
                      <span className="min-w-0 break-words">{r.item}</span>
                      <span className="shrink-0 tabular-nums">
                        sent {r.sent} · back {r.received}
                      </span>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </details>
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
