'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { giveSections } from '../actions';

/** Pick a person, tap their sections (others' show whose they are), save (ADR 133). */
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
  const [person, setPerson] = useState<string>(people[0]!.user_id);
  const [owner, setOwner] = useState<Record<string, string>>(
    Object.fromEntries(sections.flatMap((s) => (s.user_id ? [[s.section_id, s.user_id]] : []))),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const name = (id: string) => people.find((p) => p.user_id === id)?.name ?? '';
  const first = (id: string) => name(id).split(/\s+/)[0] ?? '';
  const theirs = sections.filter((s) => owner[s.section_id] === person);

  const tap = (section: string) => {
    setSaved(null);
    setOwner((o) => {
      const next = { ...o };
      if (next[section] === person) delete next[section];
      else next[section] = person;
      return next;
    });
  };

  const save = () =>
    start(async () => {
      setError(null);
      const r = await giveSections(
        department,
        day,
        person,
        theirs.map((x) => x.section_id),
      );
      if (!r.ok) return setError(r.message);
      setSaved(
        theirs.length === 0
          ? `${first(person)} has no section.`
          : `${first(person)} has ${theirs.map((x) => x.name).join(', ')}.`,
      );
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Person" className="flex flex-wrap gap-2">
        {people.map((p) => {
          const n = Object.values(owner).filter((u) => u === p.user_id).length;
          return (
            <button
              key={p.user_id}
              type="button"
              aria-pressed={person === p.user_id}
              onClick={() => {
                setPerson(p.user_id);
                setSaved(null);
              }}
              className={`min-h-12 rounded-xl px-3 text-left ring-1 ${
                person === p.user_id
                  ? 'bg-brand-700 text-white ring-brand-700'
                  : 'bg-white text-slate-800 ring-slate-300'
              }`}
            >
              <span className="block font-semibold">{p.name}</span>
              <span className="block text-xs opacity-80">
                {p.role_name} · {n} {n === 1 ? 'section' : 'sections'}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-sm text-slate-600">
        Tap {first(person)}&apos;s sections. A section someone else has moves to {first(person)}.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {sections.map((s) => {
          const o = owner[s.section_id];
          const isTheirs = o === person;
          return (
            <button
              key={s.section_id}
              type="button"
              aria-pressed={isTheirs}
              aria-label={`${s.name}${o && !isTheirs ? `, ${name(o)}'s` : ''}`}
              onClick={() => tap(s.section_id)}
              data-testid="give-section"
              className={`flex min-h-16 flex-col items-center justify-center rounded-xl ring-1 ${
                isTheirs
                  ? 'bg-brand-700 text-white ring-brand-700'
                  : o
                    ? 'bg-slate-100 text-slate-500 ring-slate-300'
                    : 'bg-white text-slate-800 ring-slate-300'
              }`}
            >
              <span className="text-base font-bold">{s.name}</span>
              {o && !isTheirs && <span className="text-[11px] font-semibold">{first(o)}</span>}
            </button>
          );
        })}
      </div>
      <ErrorBox message={error} />
      {saved && (
        <p role="status" className="text-sm font-semibold text-emerald-700">
          {saved}
        </p>
      )}
      <button
        type="button"
        onClick={save}
        disabled={!hydrated || pending}
        className={primaryButton}
      >
        Give {first(person)} {theirs.length} {theirs.length === 1 ? 'section' : 'sections'}
      </button>
    </div>
  );
}
