'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { assignShift } from '../../actions';

export function AssignButton({
  shift,
  worker,
  back,
}: {
  shift: string;
  worker: string;
  back: string;
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
            const r = await assignShift(shift, worker);
            if (!r.ok) setError(r.message);
            else router.push(back);
          })
        }
        className="min-h-11 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white disabled:opacity-50"
      >
        Assign
      </button>
      {error && (
        <span role="alert" className="max-w-40 text-right text-xs text-rose-700">
          {error}
        </span>
      )}
    </span>
  );
}
