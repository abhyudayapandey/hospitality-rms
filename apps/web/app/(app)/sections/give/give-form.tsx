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
 * section someone else has shows their name and moves when tapped. Nothing is saved until
 * Save changes; Undo puts back what was saved (the same confirm as the roster's Publish).
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
  const initial: Record<string, string> = Object.fromEntries(
    sections.flatMap((s) => (s.user_id ? [[s.section_id, s.user_id]] : [])),
  );
  const [owner, setOwner] = useState<Record<string, string>>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const first = (id: string) =>
    (people.find((p) => p.user_id === id)?.name ?? '').split(/\s+/)[0] ?? '';
  const mine = (o: Record<string, string>, person: string) =>
    sections
      .filter((s) => o[s.section_id] === person)
      .map((s) => s.section_id)
      .join();
  // the people whose sections the taps change
  const changed = people.filter((p) => mine(owner, p.user_id) !== mine(initial, p.user_id));
  const moves = sections.filter((s) => owner[s.section_id] !== initial[s.section_id]).length;

  const tap = (person: string, section: string) => {
    setSaved(false);
    setError(null);
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
      for (const p of changed) {
        const r = await callAction(
          giveSections,
          department,
          day,
          p.user_id,
          sections.filter((s) => owner[s.section_id] === p.user_id).map((s) => s.section_id),
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
      {saved && moves === 0 && (
        <p role="status" className="text-sm font-semibold text-emerald-700">
          Saved. Everyone sees their section on Home.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={!hydrated || pending || moves === 0}
          onClick={() => setOwner(initial)}
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
