import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { logbook, logbookPlaces, logbookTargets } from '@/lib/logbook';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { loadShell } from '@/lib/shell';
import { LogForm } from './log-form';
import { TakeDown } from './take-down';

// Logbook & handover (ADR 089): a place's logs that still hold and its handovers of the last
// two days, each saying who it is for and who acknowledged it; then the form to write one.
export default async function LogbookPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const shell = await loadShell();
  const places = await withUser(user.id, (tx) => logbookPlaces(tx));
  const asked = param(sp, 'place');
  const place =
    places.find((p) => isUuid(asked) && p.place_id === asked) ??
    places.find((p) => p.place_id === shell.home?.id) ??
    places[0];
  if (!place) {
    return (
      <div className="space-y-4">
        <BackLink />
        <h1 className="text-xl font-semibold">Logbook</h1>
        <Empty>You don&apos;t keep a logbook anywhere.</Empty>
      </div>
    );
  }
  const { entries, targets } = await withUser(user.id, async (tx) => ({
    entries: await logbook(tx, place.place_id),
    targets: place.can_write ? await logbookTargets(tx, place.place_id) : null,
  }));
  const logs = entries.filter((e) => e.kind === 'log');
  const handovers = entries.filter((e) => e.kind === 'handover');
  return (
    <div className="space-y-4">
      <BackLink />
      <div>
        <h1 className="text-xl font-semibold">Logbook</h1>
        <p className="text-sm text-slate-600">{place.place}</p>
      </div>
      {places.length > 1 && (
        <nav aria-label="Where" className="flex flex-wrap gap-2">
          {places.map((p) => (
            <Link
              key={p.place_id}
              href={`/logbook?place=${p.place_id}`}
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
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-500">Logs</h2>
        {logs.length === 0 ? (
          <Empty>No logs holding now.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            {logs.map((e) => (
              <li key={e.id} className="space-y-1 px-4 py-3" data-testid="log">
                <p className="text-sm whitespace-pre-line">{e.body}</p>
                <p className="flex items-center justify-between gap-2 text-xs text-slate-500">
                  <span>
                    {e.written_by}, {formatWhen(e.written_at)} · until {formatWhen(e.valid_till!)}
                  </span>
                  {e.can_take_down && <TakeDown entry={e.id} />}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-500">Handovers</h2>
        {handovers.length === 0 ? (
          <Empty>No handovers in the last two days.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            {handovers.map((e) => (
              <li key={e.id} className="space-y-1 px-4 py-3" data-testid="handover">
                <p className="text-sm whitespace-pre-line">{e.body}</p>
                <p className="text-xs text-slate-500">
                  {e.mine ? 'You' : e.written_by}, {formatWhen(e.written_at)} → {e.to_who}
                  {e.to_place && e.to_place !== place.place && ` at ${e.to_place}`}
                </p>
                <p
                  className={`text-xs font-medium ${e.acknowledged_at ? 'text-emerald-700' : 'text-amber-800'}`}
                  data-testid="handover-ack"
                >
                  {e.acknowledged_at
                    ? `Acknowledged by ${e.acknowledged_by}, ${formatWhen(e.acknowledged_at)}`
                    : 'Not acknowledged yet'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      {targets && <LogForm place={place.place_id} targets={targets} />}
    </div>
  );
}
