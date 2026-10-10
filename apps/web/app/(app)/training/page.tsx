import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { ViewTabs } from '@/components/view-tabs';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { sopReading, trainingPlaces, trainingSessions } from '@/lib/training';
import { SessionForm } from './training-forms';

// Training (ADR 095): a place's training sessions, who came and their test scores; and who has
// read each SOP that needs it.
export default async function TrainingPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const places = await withUser(user.id, (tx) => trainingPlaces(tx));
  const asked = param(sp, 'place');
  const place =
    places.find((p) => isUuid(asked) && p.place_id === asked) ??
    places.find((p) => p.kind === 'department') ??
    places[0];
  if (!place) {
    return (
      <div className="space-y-4">
        <BackLink />
        <h1 className="text-xl font-semibold">Training</h1>
        <Empty>You don&apos;t keep training anywhere.</Empty>
      </div>
    );
  }
  const view = param(sp, 'view') === 'sops' ? 'sops' : 'sessions';
  const data = await withUser(user.id, async (tx) =>
    view === 'sops'
      ? { reading: await sopReading(tx, place.place_id) }
      : { sessions: await trainingSessions(tx, place.place_id) },
  );
  const href = (p: string, v = view) => `/training?place=${p}&view=${v}`;
  return (
    <div className="space-y-4">
      <BackLink />
      <div>
        <h1 className="text-xl font-semibold">Training</h1>
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
        label="Training"
        current={view}
        tabs={[
          { key: 'sessions', label: 'Sessions', href: href(place.place_id, 'sessions') },
          { key: 'sops', label: 'SOPs read', href: href(place.place_id, 'sops') },
        ]}
      />
      {data.sessions && (
        <>
          {data.sessions.length === 0 ? (
            <Empty>No sessions in the last three months or the next two.</Empty>
          ) : (
            <ul
              className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
              data-testid="sessions"
            >
              {data.sessions.map((s) => {
                const came = s.attendance.filter((a) => a.attended).length;
                return (
                  <li key={s.id} data-testid="session">
                    <Link
                      href={`/training/${s.id}?place=${place.place_id}`}
                      className="flex min-h-11 items-center justify-between gap-3 px-4 py-3"
                    >
                      <span className="min-w-0">
                        <span className="block font-medium">{s.title}</span>
                        <span className="block text-xs text-slate-500">
                          {formatWhen(s.starts_at)}
                          {s.trainer && ` · ${s.trainer}`}
                          {s.is_test && ' · test'}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm tabular-nums">{came} came</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <SessionForm place={place.place_id} />
        </>
      )}
      {data.reading &&
        (data.reading.length === 0 ? (
          <Empty>No SOP here needs reading.</Empty>
        ) : (
          <ul
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="sop-reading"
          >
            {data.reading.map((r) => (
              <li key={r.sop_id} className="space-y-1 px-4 py-3 text-sm" data-testid="sop-read">
                <span className="flex justify-between gap-3">
                  <span className="font-medium">{r.title}</span>
                  <span className="tabular-nums">
                    {r.acked} of {r.people} read
                  </span>
                </span>
                {r.not_yet.length > 0 && (
                  <span className="block text-xs text-slate-500">
                    Not yet: {r.not_yet.join(', ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
