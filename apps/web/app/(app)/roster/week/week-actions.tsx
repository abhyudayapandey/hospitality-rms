'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton, secondaryButton, StatusBox } from '@/components/messages';
import { generateWeek, publishWeek, unassignShift } from '../actions';

export function WeekActions({
  node,
  monday,
  drafts,
  empty,
}: {
  node: string;
  monday: string;
  drafts: number;
  empty: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const build = () =>
    start(async () => {
      setError(null);
      const r = await generateWeek(node, monday);
      if (!r.ok) return setError(r.message);
      setDone(r.data === 0 ? 'All template shifts already exist.' : `Added ${r.data} shifts.`);
      router.refresh();
    });
  const publish = () =>
    start(async () => {
      setError(null);
      const r = await publishWeek(node, monday);
      if (!r.ok) return setError(r.message);
      setDone(`Published ${r.data} shifts. Staff have been notified.`);
      router.refresh();
    });
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <button type="button" disabled={pending} onClick={build} className={secondaryButton}>
          {empty ? 'Build week' : 'Add template shifts'}
        </button>
        <button
          type="button"
          disabled={pending || drafts === 0}
          onClick={publish}
          className={primaryButton}
        >
          Publish{drafts ? ` (${drafts})` : ''}
        </button>
      </div>
      <ErrorBox message={error} />
      <StatusBox message={done} />
    </div>
  );
}

export function RemoveButton({ assignment, name }: { assignment: string; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      {error && <span className="text-xs text-rose-700">{error}</span>}
      <button
        type="button"
        disabled={pending}
        aria-label={`Remove ${name}`}
        onClick={() =>
          start(async () => {
            const r = await unassignShift(assignment);
            if (!r.ok) setError(r.message);
            else router.refresh();
          })
        }
        className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-500 ring-1 ring-slate-200"
      >
        ✕
      </button>
    </span>
  );
}
