'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import {
  ErrorBox,
  StatusBox,
  inputClass,
  primaryButton,
  secondaryButton,
} from '@/components/messages';
import type { BriefingPart, Dish, PlaceNote } from '@/lib/briefing';
import { useHydrated } from '@/lib/use-hydrated';
import { saveBriefing, takeDownBriefing } from './actions';

const PARTS: readonly { part: BriefingPart; label: string; hint: string }[] = [
  { part: 'day', label: 'Whole day', hint: 'Shows all day' },
  { part: 'breakfast', label: 'Breakfast', hint: 'Shows from 4 am until 11 am' },
  { part: 'lunch', label: 'Lunch', hint: 'Shows from 11 am until 4 pm' },
  { part: 'dinner', label: 'Dinner', hint: 'Shows from 4 pm until 11 pm' },
  { part: 'late_night', label: 'Late night', hint: 'Shows from 11 pm until 4 am' },
];

const MAX = 1000;

/** The note at one place for a part of today: what to say, and the dishes that are off. */
export function BriefingForm({
  place,
  notes,
  dishes,
}: {
  place: string;
  notes: PlaceNote[];
  dishes: Dish[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [part, setPart] = useState<BriefingPart>(notes[0]?.part ?? 'day');
  const note = notes.find((n) => n.part === part) ?? null;
  const [body, setBody] = useState(note?.body ?? '');
  const [off, setOff] = useState<string[]>(note?.off_dishes ?? []);
  const [search, setSearch] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const byId = useMemo(() => new Map(dishes.map((d) => [d.id, d])), [dishes]);
  const found = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return dishes
      .filter((d) => !off.includes(d.id) && d.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [search, dishes, off]);

  const pick = (p: BriefingPart) => {
    const n = notes.find((x) => x.part === p) ?? null;
    setPart(p);
    setBody(n?.body ?? '');
    setOff(n?.off_dishes ?? []);
    setError(null);
    setStatus(null);
  };

  const save = () =>
    start(async () => {
      setError(null);
      setStatus(null);
      if (!body.trim() && off.length === 0) {
        return setError('Write something, or pick the dishes that are off today.');
      }
      const r = await saveBriefing({ place, part, body, offDishes: off, idempotencyKey: key });
      if (!r.ok) return setError(r.message);
      setKey(crypto.randomUUID());
      setStatus('Saved. Everyone at the outlet sees it on Home.');
      router.refresh();
    });

  const takeDown = () =>
    start(async () => {
      if (!note) return;
      setError(null);
      const r = await takeDownBriefing(note.id);
      if (!r.ok) return setError(r.message);
      setBody('');
      setOff([]);
      setStatus('Taken down.');
      router.refresh();
    });

  return (
    <form
      aria-label="Briefing"
      className="space-y-4 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <fieldset>
        <legend className="text-sm font-medium">For</legend>
        <div className="mt-1 grid grid-cols-3 gap-2" role="radiogroup">
          {PARTS.map((p) => {
            const has = notes.some((n) => n.part === p.part);
            return (
              <button
                key={p.part}
                type="button"
                role="radio"
                aria-checked={part === p.part}
                onClick={() => pick(p.part)}
                className={`min-h-12 rounded-lg px-2 text-sm font-medium ring-1 ${
                  part === p.part
                    ? 'bg-brand-700 text-white ring-brand-700'
                    : 'bg-white text-slate-700 ring-slate-300'
                }`}
              >
                {p.label}
                {has && <span className="block text-xs font-normal opacity-80">written</span>}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-xs text-slate-500">{PARTS.find((p) => p.part === part)!.hint}</p>
      </fieldset>

      <label className="block space-y-1">
        <span className="text-sm font-medium">What the team should know</span>
        <textarea
          value={body}
          maxLength={MAX}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Specials, guests to know about, allergies, today's target"
          className={`${inputClass} min-h-32 py-2`}
        />
        <span className="block text-right text-xs text-slate-500">
          {body.length} / {MAX}
        </span>
      </label>

      <div className="space-y-2">
        <span className="block text-sm font-medium">Off today</span>
        {off.length > 0 ? (
          <ul className="flex flex-wrap gap-2" data-testid="off-dishes">
            {off.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => setOff(off.filter((x) => x !== id))}
                  aria-label={`Back on: ${byId.get(id)?.name ?? 'dish'}`}
                  className="inline-flex min-h-11 items-center gap-1 rounded-full bg-rose-50 px-3 text-sm font-medium text-rose-800 ring-1 ring-rose-200"
                >
                  {byId.get(id)?.name ?? 'A dish no longer on the menu'}
                  <span aria-hidden>×</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">No dishes are off.</p>
        )}
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find a dish to mark off"
          aria-label="Find a dish"
          className={inputClass}
        />
        {found.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200">
            {found.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => {
                    setOff([...off, d.id]);
                    setSearch('');
                  }}
                  className="flex min-h-11 w-full items-center justify-between px-3 text-left"
                >
                  <span>{d.name}</span>
                  <span className="text-xs text-slate-500">{d.menu}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {search.trim() !== '' && found.length === 0 && (
          <p className="text-sm text-slate-500">No dish on today&apos;s menu matches.</p>
        )}
      </div>

      <ErrorBox message={error} />
      <StatusBox message={status} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        {note ? 'Save changes' : 'Share with the team'}
      </button>
      {note && (
        <button
          type="button"
          disabled={!hydrated || pending}
          onClick={takeDown}
          className={secondaryButton}
        >
          Take down
        </button>
      )}
    </form>
  );
}
