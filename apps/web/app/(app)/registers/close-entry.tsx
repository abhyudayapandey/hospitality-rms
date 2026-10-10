'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { registerDef } from '@outlet-ops/domain';
import { ErrorBox, inputClass, secondaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { closeRegisterEntry } from './actions';

/** Close an open entry (returned, left, back in), with its outcome and a note where asked. */
export function CloseEntry({ entry, register }: { entry: string; register: string }) {
  const close = registerDef(register)?.close;
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [outcome, setOutcome] = useState(close?.outcomes?.[0] ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!close) return null;
  return (
    <div className="space-y-2 pt-1">
      {close.outcomes && (
        <select
          aria-label="How"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          className={inputClass}
        >
          {close.outcomes.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      )}
      {close.noteLabel && (
        <input
          aria-label={close.noteLabel}
          placeholder={close.noteLabel}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={inputClass}
        />
      )}
      <ErrorBox message={error} />
      <button
        type="button"
        disabled={!hydrated || pending}
        className={secondaryButton}
        onClick={() =>
          start(async () => {
            const r = await closeRegisterEntry(
              entry,
              close.outcomes ? outcome : null,
              note || null,
            );
            if (!r.ok) setError(r.message);
            else router.refresh();
          })
        }
      >
        {close.label}
      </button>
    </div>
  );
}
