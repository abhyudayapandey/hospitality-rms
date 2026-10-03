'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { assignShift } from '../../actions';

/** Assign; with warnings (ADR 019) it reads "Assign anyway" and names them to the server. */
export function AssignButton({
  shift,
  worker,
  back,
  accept = [],
}: {
  shift: string;
  worker: string;
  back: string;
  accept?: string[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await assignShift(shift, worker, accept);
            if (!r.ok) setError(r.message);
            else router.push(back);
          })
        }
        className={`min-h-11 rounded-lg px-4 text-sm font-medium disabled:opacity-50 ${
          accept.length > 0
            ? 'bg-amber-100 text-amber-900 ring-1 ring-amber-300'
            : 'bg-brand-700 text-white'
        }`}
      >
        {accept.length > 0 ? 'Assign anyway' : 'Assign'}
      </button>
      {error && (
        <span role="alert" className="max-w-40 text-right text-xs text-rose-700">
          {error}
        </span>
      )}
    </span>
  );
}
