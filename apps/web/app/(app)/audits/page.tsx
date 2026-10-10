import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { auditPlaces, auditRounds } from '@/lib/audits';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { isUuid, param, type SearchParams } from '@/lib/params';

// Audits & taste panels (ADR 095): each audit at a place with its score over the last six
// months, oldest to newest as bars, then its rounds. A round is done on the To do list like any
// checklist; its score leaves out what was not applicable.
const pct = (s: string) => `${Number(s).toFixed(0)}%`;

export default async function AuditsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const places = await withUser(user.id, (tx) => auditPlaces(tx));
  const asked = param(sp, 'place');
  const place = places.find((p) => isUuid(asked) && p.place_id === asked) ?? places[0];
  if (!place) {
    return (
      <div className="space-y-4">
        <BackLink />
        <h1 className="text-xl font-semibold">Audits</h1>
        <Empty>You don&apos;t see any audits.</Empty>
      </div>
    );
  }
  const rounds = await withUser(user.id, (tx) => auditRounds(tx, place.place_id));
  const audits = [...new Map(rounds.map((r) => [r.template_id, r.audit])).entries()];
  return (
    <div className="space-y-4">
      <BackLink />
      <div>
        <h1 className="text-xl font-semibold">Audits</h1>
        <p className="text-sm text-slate-600">{place.name}</p>
      </div>
      {places.length > 1 && (
        <nav aria-label="Where" className="flex flex-wrap gap-2">
          {places.map((p) => (
            <Link
              key={p.place_id}
              href={`/audits?place=${p.place_id}`}
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
      {audits.map(([id, name]) => {
        const done = rounds.filter((r) => r.template_id === id && r.task_id && r.score !== null);
        const avg = done.length
          ? done.reduce((s, r) => s + Number(r.score), 0) / done.length
          : null;
        return (
          <section key={id} className="space-y-2" data-testid="audit">
            <h2 className="flex items-baseline justify-between font-semibold">
              {name}
              <span className="text-sm font-normal text-slate-600" data-testid="audit-average">
                {avg === null ? 'no rounds yet' : `average ${avg.toFixed(0)}%`}
              </span>
            </h2>
            {done.length > 0 && (
              <>
                <div
                  className="flex h-16 items-end gap-1 rounded-xl bg-white p-2 ring-1 ring-slate-200"
                  aria-label={`${name} scores, oldest first`}
                >
                  {[...done].reverse().map((r) => (
                    <span
                      key={r.task_id}
                      className="flex-1 rounded-t bg-brand-700"
                      style={{ height: `${Math.max(4, Number(r.score))}%` }}
                      title={pct(r.score!)}
                    />
                  ))}
                </div>
                <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
                  {done.map((r) => (
                    <li key={r.task_id} data-testid="audit-round">
                      <Link
                        href={`/tasks/${r.task_id}`}
                        className="flex min-h-11 items-center justify-between gap-3 px-4 py-2 text-sm"
                      >
                        <span>
                          {r.done_at && formatWhen(r.done_at)}
                          {r.done_by && (
                            <span className="block text-xs text-slate-500">{r.done_by}</span>
                          )}
                        </span>
                        <span className="font-medium tabular-nums" data-testid="audit-score">
                          {pct(r.score!)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
