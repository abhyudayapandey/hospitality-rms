'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, secondaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { cancelLeave } from '../../roster/actions';
import { callAction } from '@/lib/call-action';

/** Cancel approved leave that has not started (ADR 163): the person's own, or as their
 * manager. Asks once before it goes. */
export function CancelLeave({ leave, mine }: { leave: string; mine: boolean }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <button
        type="button"
        className={secondaryButton}
        disabled={!hydrated}
        onClick={() => setOpen(true)}
        data-testid="cancel-leave"
      >
        Cancel this leave
      </button>
    );
  }
  return (
    <form
      className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      aria-label="Cancel this leave"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const r = await callAction(cancelLeave, leave, reason);
          if (!r.ok) return setError(r.message);
          router.refresh();
        });
      }}
    >
      <p className="text-sm text-slate-700">
        {mine
          ? 'The days go back to your balance.'
          : 'The days go back to their balance. They are told.'}
      </p>
      <label className="block text-sm">
        Why (optional)
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={200}
          className={inputClass}
        />
      </label>
      <ErrorBox message={error} />
      <button type="submit" className={secondaryButton} disabled={!hydrated || pending}>
        Yes, cancel it
      </button>
    </form>
  );
}
