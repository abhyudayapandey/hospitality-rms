'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, secondaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { archiveBill } from '../actions';

/** A wrong bill is archived with a reason, never deleted (ADR 050). */
export function ArchiveBill({ bill, back }: { bill: string; back: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <button
        type="button"
        className={secondaryButton}
        disabled={!hydrated}
        onClick={() => setOpen(true)}
      >
        This bill is wrong
      </button>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await archiveBill(bill, reason);
          if (r.ok) router.push(back);
          else setError(r.message);
        });
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium">Why? (it is kept, marked archived)</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={300}
          required
          placeholder="e.g. Added twice"
          className={inputClass}
        />
      </label>
      <ErrorBox message={error} />
      <button type="submit" disabled={pending} className={secondaryButton}>
        Archive the bill
      </button>
    </form>
  );
}
