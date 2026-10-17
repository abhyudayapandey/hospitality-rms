'use client';

import { useState, useTransition } from 'react';
import { ErrorBox } from '@/components/messages';
import { callAction } from '@/lib/call-action';
import { useHydrated } from '@/lib/use-hydrated';
import { seeHandover } from './actions';

/** "Seen": the handover's card leaves my Home (ADR 118). */
export function SeenButton({ task }: { task: string }) {
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={!hydrated || pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await callAction(seeHandover, task);
            if (r) setError(r.message);
          })
        }
        className="min-h-12 w-full rounded-xl bg-brand-700 font-semibold text-white disabled:opacity-60"
        data-testid="handover-seen"
      >
        Seen
      </button>
      <ErrorBox message={error} />
    </>
  );
}
