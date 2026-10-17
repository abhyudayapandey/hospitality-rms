'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Initials } from '@/components/initials';
import { ErrorBox, primaryButton, secondaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { giveSections } from '../actions';
import { callAction } from '@/lib/call-action';

/**
 * Give sections as the roster by person (ADR 133): a row per person with every section as a
 * tile. A tap marks it for them, tapped again it comes off; a person may have several, and a
 * section may go to several people (ADR 170): a tile names the others who have it, and a tap
 * adds this person without taking it from them. Nothing is saved until Save changes; Undo puts
 * back what was saved (the same confirm as the roster's Publish).
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
  sections: { section_id: string; name: string; user_ids: string[] }[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  // who has which section, as "section|person" pairs
  const pair = (section: string, person: string) => `${section}|${person}`;
  const initial = new Set(sections.flatMap((s) => s.user_ids.map((u) => pair(s.section_id, u))));
  const [given, setGiven] = useState<Set<string>>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const first = (id: string) =>
    (people.find((p) => p.user_id === id)?.name ?? '').split(/\s+/)[0] ?? '';
  const mine = (g: Set<string>, person: string) =>
    sections.filter((s) => g.has(pair(s.section_id, person))).map((s) => s.section_id);
  // the people whose sections the taps change
  const changed = people.filter(
    (p) => mine(given, p.user_id).join() !== mine(initial, p.user_id).join(),
  );
  const moves =
    [...given].filter((k) => !initial.has(k)).length +
    [...initial].filter((k) => !given.has(k)).length;
  const others = (section: string, person: string) =>
    people
      .filter((p) => p.user_id !== person && given.has(pair(section, p.user_id)))
      .map((p) => first(p.user_id));

  const tap = (person: string, section: string) => {
    setSaved(false);
    setError(null);
    setGiven((g) => {
      const next = new Set(g);
      const k = pair(section, person);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const save = () =>
    start(async () => {
      setError(null);
      for (const p of changed) {
        const r = await callAction(
          giveSections,
          department,
          day,
          p.user_id,
          mine(given, p.user_id),
        );
        if (!r.ok) {
          setError(r.message);
          return;
        }
      }
      setSaved(true);
      router.refresh();
    });

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
                const on = given.has(pair(s.section_id, p.user_id));
                const also = others(s.section_id, p.user_id);
                return (
                  <button
                    key={s.section_id}
                    type="button"
                    disabled={!hydrated || pending}
                    onClick={() => tap(p.user_id, s.section_id)}
                    aria-pressed={on}
                    aria-label={`${s.name}${also.length ? `, also ${also.join(', ')}` : ''}`}
                    data-testid="section-tile"
                    className={`flex min-h-14 flex-col items-center justify-center rounded-lg px-2 text-sm ring-1 ${
                      on
                        ? 'bg-brand-700 font-semibold text-white ring-brand-700'
                        : 'bg-white text-slate-800 ring-slate-300'
                    }`}
                  >
                    <span className="font-semibold">{s.name}</span>
                    {also.length > 0 && (
                      <span
                        className={`max-w-full truncate text-[11px] ${on ? '' : 'text-slate-500'}`}
                      >
                        also {also.join(', ')}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
      {saved && moves === 0 && (
        <p role="status" className="text-sm font-semibold text-emerald-700">
          Saved. Everyone sees their section on Home.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={!hydrated || pending || moves === 0}
          onClick={() => setGiven(initial)}
          className={secondaryButton}
        >
          Undo
        </button>
        <button
          type="button"
          disabled={!hydrated || pending || moves === 0}
          onClick={save}
          className={primaryButton}
          data-testid="save-sections"
        >
          Save changes{moves ? ` (${moves})` : ''}
        </button>
      </div>
    </div>
  );
}
