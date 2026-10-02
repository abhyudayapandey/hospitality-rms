'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { RequestDecision } from '@/components/request-decision';
import { approveSwap, reassignSwap } from '../../actions';

/** Approve (naming the warnings shown) or reject; ADR 019. */
export function SwapDecision({
  swap,
  requestId,
  accept,
}: {
  swap: string;
  requestId: string;
  accept: string[];
}) {
  return (
    <RequestDecision
      requestId={requestId}
      back="/inbox"
      approve={() => approveSwap(swap, '', accept)}
      approveLabel={accept.length > 0 ? 'Approve anyway' : 'Approve'}
    />
  );
}

/** Give the shift to this person instead: straight onto their roster, no approval. */
export function ReassignButton({
  swap,
  worker,
  accept,
}: {
  swap: string;
  worker: string;
  accept: string[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending || done}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await reassignSwap(swap, worker, accept);
            if (!r.ok) setError(r.message);
            else {
              setDone(true);
              setTimeout(() => router.push('/inbox'), 1200);
            }
          })
        }
        className={`min-h-11 rounded-lg px-4 text-sm font-medium disabled:opacity-50 ${
          accept.length > 0
            ? 'bg-amber-100 text-amber-900 ring-1 ring-amber-300'
            : 'bg-white text-slate-900 ring-1 ring-slate-300'
        }`}
      >
        {done ? 'Assigned' : accept.length > 0 ? 'Assign anyway' : 'Assign'}
      </button>
      {error && (
        <span role="alert" className="max-w-40 text-right text-xs text-rose-700">
          {error}
        </span>
      )}
    </span>
  );
}
