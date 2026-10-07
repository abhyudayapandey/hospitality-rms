'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { ErrorBox, inputClass } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { backToMe, showAs } from './actions';

export interface ShowAsPerson {
  id: string;
  name: string;
  job_title: string | null;
  place: string | null;
  outlet: string | null;
}

/** Everyone the presenter may show as, by outlet and place, with a search. */
export function PeopleList({
  people,
  current,
  presenterName,
}: {
  people: ShowAsPerson[];
  current: string | null;
  presenterName: string;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const shown = people.filter(
      (p) =>
        !needle || [p.name, p.job_title, p.place].some((s) => s?.toLowerCase().includes(needle)),
    );
    const by = new Map<string, ShowAsPerson[]>();
    for (const p of shown) {
      const k = p.outlet ?? 'The company';
      by.set(k, [...(by.get(k) ?? []), p]);
    }
    return [...by.entries()];
  }, [people, q]);

  const pick = (id: string) =>
    start(async () => {
      setError(null);
      const r = await showAs(id);
      if (!r.ok) return setError(r.message);
      router.push('/');
      router.refresh();
    });

  const back = () =>
    start(async () => {
      setError(null);
      const r = await backToMe();
      if (!r.ok) return setError(r.message);
      router.push('/');
      router.refresh();
    });

  return (
    <div className="space-y-4">
      {current && (
        <button
          type="button"
          onClick={back}
          disabled={!hydrated || pending}
          className="flex min-h-12 w-full items-center justify-center rounded-lg bg-brand-700 px-4 font-medium text-white"
        >
          Back to me ({presenterName})
        </button>
      )}
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Find a person, job or department"
        aria-label="Find a person"
        className={inputClass}
      />
      <ErrorBox message={error} />
      {groups.map(([outlet, list]) => (
        <section key={outlet} aria-label={outlet} className="space-y-2">
          <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{outlet}</h2>
          <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            {list.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => pick(p.id)}
                  disabled={!hydrated || pending || p.id === current}
                  data-testid="show-as-person"
                  className="flex min-h-14 w-full items-center justify-between gap-3 px-3 py-2 text-left"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{p.name}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {[p.job_title, p.place].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {p.id === current && (
                    <span className="shrink-0 text-xs font-semibold text-brand-700">Showing</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {groups.length === 0 && <p className="text-sm text-slate-500">Nobody matches.</p>}
    </div>
  );
}
