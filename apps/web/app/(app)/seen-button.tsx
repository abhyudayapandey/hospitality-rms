'use client';

import { useTransition } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { seeHandover } from './actions';

/** "Seen": the handover's card leaves my Home (ADR 118). */
export function SeenButton({ task }: { task: string }) {
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={!hydrated || pending}
      onClick={() => start(() => seeHandover(task))}
      className="min-h-12 w-full rounded-xl bg-brand-700 font-semibold text-white disabled:opacity-60"
      data-testid="handover-seen"
    >
      Seen
    </button>
  );
}
