import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { briefingAt, briefingDishes, briefingPlaces } from '@/lib/briefing';
import { withUser } from '@/lib/db';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { loadShell } from '@/lib/shell';
import { BriefingForm } from './briefing-form';

// Today's briefing (ADR 069): the note for the outlet's shift, written by the heads of
// kitchen and service departments and the outlet's managers. One note per place and part of
// the day; saving again edits it. Everyone at the outlet reads it on Home.
export default async function BriefingPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const shell = await loadShell();
  const places = await withUser(user.id, (tx) => briefingPlaces(tx));
  const asked = param(sp, 'place');
  const place =
    places.find((p) => isUuid(asked) && p.place_id === asked) ??
    places.find((p) => p.place_id === shell.home?.id) ??
    places[0];
  if (!place) {
    return (
      <div className="space-y-4">
        <BackLink />
        <h1 className="text-xl font-semibold">Today&apos;s briefing</h1>
        <Empty>
          You don&apos;t write the briefing anywhere. It shows on Home for everyone at the outlet.
        </Empty>
      </div>
    );
  }
  const { notes, dishes } = await withUser(user.id, async (tx) => ({
    notes: await briefingAt(tx, place.place_id),
    dishes: await briefingDishes(tx, place.place_id),
  }));
  return (
    <div className="space-y-4">
      <BackLink />
      <div>
        <h1 className="text-xl font-semibold">Today&apos;s briefing</h1>
        <p className="text-sm text-slate-600">Everyone at {place.outlet} sees it on Home today.</p>
      </div>
      {places.length > 1 && (
        <nav aria-label="Where" className="flex flex-wrap gap-2" data-testid="briefing-places">
          {places.map((p) => (
            <Link
              key={p.place_id}
              href={`/briefing?place=${p.place_id}`}
              aria-current={p.place_id === place.place_id ? 'page' : undefined}
              className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium ring-1 ${
                p.place_id === place.place_id
                  ? 'bg-brand-700 text-white ring-brand-700'
                  : 'bg-white text-slate-700 ring-slate-300'
              }`}
            >
              {p.kind === 'outlet' ? `${p.place} (whole outlet)` : p.place}
            </Link>
          ))}
        </nav>
      )}
      <BriefingForm key={place.place_id} place={place.place_id} notes={notes} dishes={dishes} />
    </div>
  );
}
