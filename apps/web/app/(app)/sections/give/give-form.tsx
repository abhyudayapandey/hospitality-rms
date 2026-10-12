'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Initials } from '@/components/initials';
import { ErrorBox } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { giveSections } from '../actions';

/**
 * Give sections as the roster by person (ADR 133): a row per person with every section as a
 * tile. A tap lights it for them and saves at once; tapped again it is taken off. A person may
 * have several. A section someone else has shows their name, and a tap moves it to this row.
 */
export function GiveSectionsForm({
  department,
  day,
  people,
  sections,
}: {
  department: string;
  day: string;
  people: { user_id: string; name: string; role_name: string }[];
  sections: { section_id: string; name: string; user_id: string | null }[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [owner, setOwner] = useState<Record<string, string>>(
    Object.fromEntries(sections.flatMap((s) => (s.user_id ? [[s.section_id, s.user_id]] : []))),
  );
  const [error, setError] = useState<string | null>(null);
  const first = (id: string) =>
    (people.find((p) => p.user_id === id)?.name ?? '').split(/\s+/)[0] ?? '';

  const tap = (person: string, section: string) => {
    const before = owner;
    const next = { ...owner };
    if (next[section] === person) delete next[section];
    else next[section] = person;
    setOwner(next);
    setError(null);
    start(async () => {
      const r = await giveSections(
        department,
        day,
        person,
        sections.filter((s) => next[s.section_id] === person).map((s) => s.section_id),
      );
      if (!r.ok) {
        setOwner(before);
        setError(r.message);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <ErrorBox message={error} />
      <ul className="space-y-3">
        {people.map((p) => (
          <li
            key={p.user_id}
            className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-slate-200"
            data-testid="person-row"
            data-name={p.name}
          >
            <p className="flex items-center gap-2">
              <Initials name={p.name} className="size-8 text-xs" />
              <span className="min-w-0 flex-1 font-medium">{p.name}</span>
              <span className="text-xs text-slate-500">{p.role_name}</span>
            </p>
            <div className="grid grid-cols-3 gap-2">
              {sections.map((s) => {
                const o = owner[s.section_id];
                const on = o === p.user_id;
                return (
                  <button
                    key={s.section_id}
                    type="button"
                    disabled={!hydrated || pending}
                    onClick={() => tap(p.user_id, s.section_id)}
                    aria-pressed={on}
                    aria-label={`${s.name}${o && !on ? `, ${first(o)}'s` : ''}`}
                    data-testid="section-tile"
                    className={`flex min-h-14 flex-col items-center justify-center rounded-lg px-2 text-sm ring-1 ${
                      on
                        ? 'bg-brand-700 font-semibold text-white ring-brand-700'
                        : o
                          ? 'bg-slate-50 text-slate-400 ring-slate-200'
                          : 'bg-white text-slate-800 ring-slate-300'
                    }`}
                  >
                    <span className="font-semibold">{s.name}</span>
                    {o && !on && <span className="text-[11px]">{first(o)}&apos;s</span>}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
