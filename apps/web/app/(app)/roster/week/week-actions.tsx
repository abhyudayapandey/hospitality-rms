'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton, secondaryButton, StatusBox } from '@/components/messages';
import { addTemplateShifts, discardDrafts, publishWeek, unassignShift } from '../actions';

/** What "Add template shifts" would do for tomorrow to day 7 (hr.preview_template_shifts). */
export interface TemplateWindow {
  toAdd: number;
  drafts: number;
  span: string; // 'Sat 3 Oct – Fri 9 Oct'
  nextWeek: string | null; // link to next week when the seven days run into it
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Template shifts are added only for tomorrow to day 7, after the manager confirms; while
// drafts exist in those days, "Discard drafts" takes the place of "Add template shifts"
// (ADR 024). Publish still publishes the week on screen.
export function WeekActions({
  node,
  monday,
  drafts,
  window: w,
}: {
  node: string;
  monday: string;
  drafts: number;
  window: TemplateWindow;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'add' | 'discard' | null>(null);
  const after = (message: string) => {
    setConfirm(null);
    setDone(message);
    router.refresh();
  };
  const add = () =>
    start(async () => {
      setError(null);
      const r = await addTemplateShifts(node);
      if (!r.ok) return setError(r.message);
      after(
        r.data === 0
          ? 'All template shifts already exist.'
          : `Added ${plural(r.data, 'draft shift')}, ${w.span}.`,
      );
    });
  const discard = () =>
    start(async () => {
      setError(null);
      const r = await discardDrafts(node);
      if (!r.ok) return setError(r.message);
      after(`Discarded ${plural(r.data, 'draft shift')}.`);
    });
  const publish = () =>
    start(async () => {
      setError(null);
      const r = await publishWeek(node, monday);
      if (!r.ok) return setError(r.message);
      after(`Published ${r.data} shifts. Staff have been notified.`);
    });
  const ask = (what: 'add' | 'discard') => {
    setError(null);
    setDone(null);
    setConfirm(what);
  };
  return (
    <div className="space-y-2">
      {confirm ? (
        <div
          className="space-y-3 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200"
          role="group"
          aria-label={confirm === 'add' ? 'Add template shifts' : 'Discard drafts'}
        >
          <p className="text-sm" data-testid="confirm-text">
            {confirm === 'add'
              ? `Add ${plural(w.toAdd, 'draft shift')}, ${w.span}? Staff see them only after you publish.`
              : `Discard ${plural(w.drafts, 'draft shift')}, ${w.span}? Anyone assigned to them is freed. Published shifts stay.`}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirm(null)}
              className={secondaryButton}
            >
              {confirm === 'add' ? 'Cancel' : 'Keep drafts'}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={confirm === 'add' ? add : discard}
              className={primaryButton}
            >
              {confirm === 'add' ? 'Add' : 'Discard'}
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {w.drafts > 0 ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => ask('discard')}
              className={secondaryButton}
            >
              Discard drafts ({w.drafts})
            </button>
          ) : (
            <button
              type="button"
              disabled={pending || w.toAdd === 0}
              onClick={() => ask('add')}
              className={secondaryButton}
            >
              Add template shifts
            </button>
          )}
          <button
            type="button"
            disabled={pending || drafts === 0}
            onClick={publish}
            className={primaryButton}
          >
            Publish{drafts ? ` (${drafts})` : ''}
          </button>
        </div>
      )}
      <p className="text-xs text-slate-500" data-testid="template-window">
        {w.drafts === 0 && w.toAdd === 0
          ? `Template shifts for ${w.span} are all added.`
          : `Template shifts are added for ${w.span} (tomorrow to day 7).`}
        {w.nextWeek && (w.drafts > 0 || done) ? (
          <>
            {' '}
            <Link href={w.nextWeek} className="underline">
              Next week →
            </Link>
          </>
        ) : null}
      </p>
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
