import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { ShowMore } from '@/components/show-more';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { LIST_PAGE } from '@/lib/list-page';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { utilityDays, utilityMeters, utilityMonths, utilityPlaces } from '@/lib/utilities';

// Utilities (ADR 091, 097): every meter of the place, read yet or not, and its use from the
// daily readings: the last 60 days, newest first (30, then "Show more"), then month by month for
// the last year. The readings come from the meter round on the To do list of whoever reads them,
// and are kept for good.
const DAYS = 60;
const num = (v: string) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(Number(v));

export default async function UtilitiesPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const places = await withUser(user.id, (tx) => utilityPlaces(tx));
  const asked = param(sp, 'place');
  const place = places.find((p) => isUuid(asked) && p.place_id === asked) ?? places[0];
  if (!place) {
    return (
      <div className="space-y-4">
        <BackLink />
        <h1 className="text-xl font-semibold">Utilities</h1>
        <Empty>You don&apos;t see any meters.</Empty>
      </div>
    );
  }
  const { meters, days, months } = await withUser(user.id, async (tx) => ({
    meters: await utilityMeters(tx, place.place_id),
    days: await utilityDays(tx, place.place_id, DAYS),
    months: await utilityMonths(tx, place.place_id),
  }));
  // the meter whose days are all shown ("Show more")
  const all = param(sp, 'all');
  const monthMeters = [...new Map(months.map((m) => [m.meter_id, m])).values()];
  const dayWords = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return (
    <div className="space-y-4">
      <BackLink />
      <div>
        <h1 className="text-xl font-semibold">Utilities</h1>
        <p className="text-sm text-slate-600">{place.name}</p>
      </div>
      {places.length > 1 && (
        <nav aria-label="Where" className="flex flex-wrap gap-2">
          {places.map((p) => (
            <Link
              key={p.place_id}
              href={`/utilities?place=${p.place_id}`}
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
      {meters.length === 0 ? (
        <Empty>There are no meters here.</Empty>
      ) : (
        meters.map((m) => {
          const rows = days.filter((d) => d.meter_id === m.meter_id).reverse();
          const shown = all === m.meter_id ? rows : rows.slice(0, LIST_PAGE);
          return (
            <section key={m.meter_id} className="space-y-2" data-testid="meter">
              <div>
                <h2 className="font-semibold">
                  {m.meter} <span className="text-sm font-normal text-slate-500">({m.unit})</span>
                </h2>
                <p className="text-sm text-slate-600" data-testid="meter-last">
                  {m.last_reading === null
                    ? `No reading yet.${m.read_by ? ` ${m.read_by} reads it at ${m.read_at} each day.` : ''}`
                    : `Last reading ${num(m.last_reading)} ${m.unit}, ${formatWhen(m.last_read_at!)}.${m.read_by ? ` Read by ${m.read_by} at ${m.read_at}.` : ''}`}
                </p>
              </div>
              {rows.length === 0 ? (
                // a meter never read says so above; one read long ago says how long
                m.last_reading !== null && <Empty>No readings in the last {DAYS} days.</Empty>
              ) : (
                <>
                  <table className="w-full rounded-xl bg-white text-sm ring-1 ring-slate-200">
                    <thead>
                      <tr className="text-left text-xs text-slate-500">
                        <th className="px-3 py-2 font-medium">Day</th>
                        <th className="px-3 py-2 text-right font-medium">Reading</th>
                        <th className="px-3 py-2 text-right font-medium">Used</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {shown.map((d) => (
                        <tr key={d.day} data-testid="meter-day">
                          <td className="px-3 py-2">{dayWords(d.day)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{num(d.reading)}</td>
                          <td
                            className={`px-3 py-2 text-right tabular-nums ${d.used !== null && Number(d.used) < 0 ? 'text-rose-700' : ''}`}
                          >
                            {d.used === null ? '–' : num(d.used)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {shown.length < rows.length && (
                    <ShowMore href={`/utilities?place=${place.place_id}&all=${m.meter_id}`} />
                  )}
                </>
              )}
            </section>
          );
        })
      )}
      {monthMeters.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">By month</h2>
          <ul className="divide-y divide-slate-100 rounded-xl bg-white text-sm ring-1 ring-slate-200">
            {monthMeters.map((m) => (
              <li key={m.meter_id} className="px-3 py-2" data-testid="meter-months">
                <span className="font-medium">{m.meter}</span>
                <span className="block text-slate-600">
                  {months
                    .filter((x) => x.meter_id === m.meter_id)
                    .map(
                      (x) =>
                        `${new Date(`${x.month}T00:00:00`).toLocaleDateString('en-IN', { month: 'short' })} ${x.used === null ? '–' : num(x.used)}`,
                    )
                    .join(' · ')}{' '}
                  {m.unit}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
