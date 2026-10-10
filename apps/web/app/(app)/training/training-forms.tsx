'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { addSession, markAttendance } from './actions';

/** A new training session at a place (ADR 095): what, when, who trains, and whether it is a test. */
export function SessionForm({ place }: { place: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState('');
  const [at, setAt] = useState('');
  const [trainer, setTrainer] = useState('');
  const [isTest, setIsTest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    start(async () => {
      setError(null);
      if (!title.trim() || !at) return setError('Say what it is and when.');
      const r = await addSession({
        place,
        title,
        startsAt: new Date(at).toISOString(),
        trainer,
        isTest,
      });
      if (!r.ok) return setError(r.message);
      router.push(`/training/${r.data.id}?place=${place}`);
    });
  return (
    <form
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <h2 className="font-semibold">A training session</h2>
      <label className="block space-y-1">
        <span className="text-sm font-medium">What</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">When</span>
        <input
          type="datetime-local"
          value={at}
          onChange={(e) => setAt(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Trainer (optional)</span>
        <input
          value={trainer}
          onChange={(e) => setTrainer(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={isTest} onChange={(e) => setIsTest(e.target.checked)} />
        It has a test with a score
      </label>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Add the session
      </button>
    </form>
  );
}

/** One person's attendance at a session, and their score on a test. */
export function AttendanceRow({
  session,
  person,
  name,
  isTest,
  attended,
  score,
}: {
  session: string;
  person: string;
  name: string;
  isTest: boolean;
  attended: boolean | null;
  score: number | null;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [came, setCame] = useState(attended ?? false);
  const [mark, setMark] = useState(score === null ? '' : String(score));
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    start(async () => {
      setError(null);
      const r = await markAttendance(
        session,
        person,
        came,
        isTest && came && mark.trim() !== '' ? Number(mark) : null,
      );
      if (!r.ok) return setError(r.message);
      router.refresh();
    });
  return (
    <li className="space-y-2 px-4 py-3" data-testid="attendance">
      <div className="flex items-center justify-between gap-3">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={came}
            onChange={(e) => setCame(e.target.checked)}
            aria-label={`${name} came`}
          />
          {name}
        </label>
        {isTest && (
          <input
            inputMode="decimal"
            aria-label={`${name} score`}
            placeholder="Score %"
            value={mark}
            onChange={(e) => setMark(e.target.value)}
            className={`${inputClass} w-24 text-right`}
          />
        )}
        <button
          type="button"
          onClick={save}
          disabled={!hydrated || pending}
          className={secondaryButton}
        >
          {attended === null ? 'Save' : 'Saved · change'}
        </button>
      </div>
      <ErrorBox message={error} />
    </li>
  );
}
