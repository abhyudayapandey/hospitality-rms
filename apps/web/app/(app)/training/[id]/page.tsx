import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { trainingPlaces, trainingSessions } from '@/lib/training';
import { AttendanceRow } from '../training-forms';

// A training session (ADR 095): everyone who works at its place, whether they came, and on a
// test their score.
export default async function SessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const placeId = param(sp, 'place');
  const back = `/training?place=${placeId}`;
  if (!isUuid(id) || !isUuid(placeId)) return <Empty>That session is not there.</Empty>;
  const user = await requireUser();
  const { session, place } = await withUser(user.id, async (tx) => ({
    session: (await trainingSessions(tx, placeId)).find((s) => s.id === id),
    place: (await trainingPlaces(tx)).find((p) => p.place_id === placeId),
  }));
  if (!session || !place) return <Empty>That session is not there.</Empty>;
  const marked = new Map(session.attendance.map((a) => [a.person_id, a]));
  return (
    <div className="space-y-4">
      <BackLink fallback={back} />
      <div>
        <h1 className="text-xl font-semibold">{session.title}</h1>
        <p className="text-sm text-slate-600">
          {place.name} · {formatWhen(session.starts_at)}
          {session.trainer && ` · ${session.trainer}`}
        </p>
      </div>
      <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
        {place.people.map((p) => (
          <AttendanceRow
            key={p.id}
            session={session.id}
            person={p.id}
            name={p.name}
            isTest={session.is_test}
            attended={marked.get(p.id)?.attended ?? null}
            score={marked.get(p.id)?.score ?? null}
          />
        ))}
      </ul>
    </div>
  );
}
