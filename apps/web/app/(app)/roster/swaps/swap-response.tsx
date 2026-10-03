'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox } from '@/components/messages';
import { respondSwap, withdrawSwap } from '../actions';

export function SwapResponse({
  swap,
  direction,
}: {
  swap: string;
  direction: 'incoming' | 'outgoing';
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.message ?? 'Something went wrong.');
      else router.refresh();
    });
  return (
    <div className="mt-3 space-y-2">
      {direction === 'incoming' ? (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => respondSwap(swap, false))}
            className="min-h-11 rounded-lg text-sm font-medium ring-1 ring-slate-300 disabled:opacity-50"
          >
            Decline
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => respondSwap(swap, true))}
            className="min-h-11 rounded-lg bg-brand-700 text-sm font-medium text-white disabled:opacity-50"
          >
            Accept
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => withdrawSwap(swap))}
          className="min-h-11 w-full rounded-lg text-sm font-medium ring-1 ring-slate-300 disabled:opacity-50"
        >
          Withdraw offer
        </button>
      )}
      <ErrorBox message={error} />
    </div>
  );
}
