'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Icon } from '@/components/icon';
import { formatDay } from '@/lib/dates';
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

// Template shifts are added only for tomorrow to day 7, after the manager confirms. While there
// are changes not yet published (drafts, or people put on or taken off a published shift), in
// those days or in the week on screen, "Start again" takes the place of "Add template shifts":
// it undoes them all, so the manager can begin afresh (ADR 024, 132, 135). Publish (N)
// publishes the week on screen: N counts every change, Off included.
export function WeekActions({
  node,
  monday,
  drafts,
  window: w,
  empty = false,
}: {
  node: string;
  monday: string;
  window: TemplateWindow;
  /** changes in the week not yet published: draft shifts, people on or off (ADR 135) */
  drafts: number;
  /** no shifts on screen: one big Fill button instead of the counts and the buttons (ADR 107) */
  empty?: boolean;
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
      const r = await discardDrafts(node, monday);
      if (!r.ok) return setError(r.message);
      after(
        r.data === 0
          ? 'Nothing to undo: those shifts have already started.'
          : `Undid ${plural(r.data, 'change')}. The roster is back as published.`,
      );
    });
  const publish = () =>
    start(async () => {
      setError(null);
      const r = await publishWeek(node, monday);
      if (!r.ok) return setError(r.message);
      after(`Published ${plural(r.data, 'change')}. Staff have been told.`);
    });
  const ask = (what: 'add' | 'discard') => {
    setError(null);
    setDone(null);
    setConfirm(what);
  };
  // an empty week: one big button that adds the usual shifts as drafts (nobody sees drafts
  // until they are published, and Start again takes them back)
  if (empty && w.drafts === 0 && w.toAdd > 0 && !done) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          disabled={pending}
          onClick={add}
          data-testid="fill-week"
          className="flex min-h-20 w-full items-center justify-center gap-3 rounded-xl bg-brand-700 px-4 text-lg font-semibold text-white disabled:opacity-50"
        >
          <Icon name="calendar" className="size-8" />
          Fill the week of {formatDay(monday)} from the usual shifts
        </button>
        <ErrorBox message={error} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {confirm ? (
        <div
          className="space-y-3 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200"
          role="group"
          aria-label={confirm === 'add' ? 'Add template shifts' : 'Start again'}
        >
          <p className="text-sm" data-testid="confirm-text">
            {confirm === 'add'
              ? `Add ${plural(w.toAdd, 'draft shift')}, ${w.span}? Staff see them only after you publish.`
              : 'Undo every change not yet published, this week and the next 7 days? The roster goes back to what staff last saw.'}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirm(null)}
              className={secondaryButton}
            >
              {confirm === 'add' ? 'Cancel' : 'Keep changes'}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={confirm === 'add' ? add : discard}
              className={primaryButton}
            >
              {confirm === 'add' ? 'Add' : 'Undo changes'}
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {w.drafts > 0 || drafts > 0 ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => ask('discard')}
              className={secondaryButton}
            >
              Start again
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
          ? `The usual shifts for ${w.span} are all added.`
          : `Adds the usual shifts for ${w.span}.`}
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
