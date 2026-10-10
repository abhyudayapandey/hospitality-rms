'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { setCovers } from './actions';

const PERIOD_WORDS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' } as const;
type Period = keyof typeof PERIOD_WORDS;

/** The day's covers per meal period (ADR 096); nothing is filled in that was not given. */
export function CoversForm({
  outlet,
  day,
  given,
}: {
  outlet: string;
  day: string;
  given: Record<Period, number | null>;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [values, setValues] = useState<Record<Period, string>>({
    breakfast: given.breakfast?.toString() ?? '',
    lunch: given.lunch?.toString() ?? '',
    dinner: given.dinner?.toString() ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    start(async () => {
      setError(null);
      const changed = (Object.keys(PERIOD_WORDS) as Period[]).filter(
        (p) => values[p].trim() !== '' && Number(values[p]) !== given[p],
      );
      for (const p of changed) {
        const n = Number(values[p]);
        if (!Number.isInteger(n) || n < 0) return setError('Covers are a whole number.');
      }
      for (const p of changed) {
        const r = await setCovers(outlet, day, p, Number(values[p]));
        if (!r.ok) return setError(r.message);
      }
      router.refresh();
    });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="grid grid-cols-3 gap-2">
        {(Object.keys(PERIOD_WORDS) as Period[]).map((p) => (
          <label key={p} className="block space-y-1">
            <span className="text-sm font-medium">{PERIOD_WORDS[p]}</span>
            <input
              inputMode="numeric"
              value={values[p]}
              onChange={(e) => setValues((v) => ({ ...v, [p]: e.target.value }))}
              className={inputClass}
            />
          </label>
        ))}
      </div>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Save covers
      </button>
    </form>
  );
}
