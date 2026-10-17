import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { addDays, formatDay } from '@/lib/dates';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { sectionPeople, sectionPlaces, sectionsOn } from '@/lib/sections';
import { sql, withUser } from '@/lib/db';
import { GiveSectionsForm } from './give-form';

// Give sections (ADR 133): the restaurant's or bar's manager, or a captain, picks a server, taps
// their sections and saves; today's or tomorrow's. As Give rooms (ADR 111).
export default async function GiveSectionsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const places = await withUser(user.id, (tx) => sectionPlaces(tx));
  const asked = param(sp, 'department');
  const place = places.find((p) => isUuid(asked) && p.department_id === asked) ?? places[0];
  if (!place) notFound();
  const data = await withUser(user.id, async (tx) => {
    const today = (
      await sql<{ d: string }>`select rpt.today(${place.department_id}::uuid)::text as d`.execute(
        tx,
      )
    ).rows[0]!.d;
    const askedDay = param(sp, 'day');
    const day = askedDay === addDays(today, 1) ? askedDay : today;
    return {
      today,
      day,
      people: await sectionPeople(tx, place.department_id),
      sections: await sectionsOn(tx, place.department_id, day),
    };
  });
  const href = (d: string) => `/sections/give?department=${place.department_id}&day=${d}`;
  return (
    <div className="space-y-4">
      <BackLink fallback="/" />
      <div>
        <h1 className="text-xl font-semibold">Give sections</h1>
        <p className="text-sm text-slate-600">
          {place.name}
          {place.outlet_name ? ` · ${place.outlet_name}` : ''}
        </p>
      </div>
      {places.length > 1 && (
        <nav aria-label="Place" className="flex flex-wrap gap-2">
          {places.map((p) => (
            <Link
              key={p.department_id}
              href={`/sections/give?department=${p.department_id}`}
              aria-current={p.department_id === place.department_id ? 'page' : undefined}
              className={`flex min-h-11 items-center rounded-full px-4 text-sm ring-1 ${
                p.department_id === place.department_id
                  ? 'bg-brand-700 font-semibold text-white ring-brand-700'
                  : 'bg-white ring-slate-300'
              }`}
            >
              {p.name}
            </Link>
          ))}
        </nav>
      )}
      <nav aria-label="Day" className="flex gap-2">
        {[
          [data.today, 'Today'],
          [addDays(data.today, 1), 'Tomorrow'],
        ].map(([d, w]) => (
          <Link
            key={d}
            href={href(d!)}
            aria-current={d === data.day ? 'page' : undefined}
            className={`flex min-h-11 items-center rounded-full px-4 text-sm ring-1 ${
              d === data.day
                ? 'bg-brand-700 font-semibold text-white ring-brand-700'
                : 'bg-white ring-slate-300'
            }`}
          >
            {w}, {formatDay(d!)}
          </Link>
        ))}
      </nav>
      {/* what is given, as saved: shown first, so a saved change is seen (AM-03, ADR 164) */}
      <section
        aria-label="Given"
        className="rounded-xl bg-white p-3 ring-1 ring-slate-200"
        data-testid="sections-given"
      >
        <h2 className="text-sm font-semibold text-slate-500">
          {data.day === data.today ? 'Given today' : 'Given for tomorrow'}
        </h2>
        <ul className="mt-1 text-sm">
          {data.sections.map((x) => (
            <li
              key={x.section_id}
              className="flex min-h-8 items-center justify-between gap-2"
              data-testid="section-given"
            >
              <span>{x.name}</span>
              <span className={`text-right ${x.user_names ? 'font-medium' : 'text-slate-500'}`}>
                {x.user_names ?? 'Not given yet'}
              </span>
            </li>
          ))}
        </ul>
      </section>
      {data.people.length === 0 ? (
        <Empty>No one works here yet.</Empty>
      ) : (
        <GiveSectionsForm
          key={`${place.department_id}-${data.day}`}
          department={place.department_id}
          day={data.day}
          people={data.people}
          sections={data.sections}
        />
      )}
    </div>
  );
}
