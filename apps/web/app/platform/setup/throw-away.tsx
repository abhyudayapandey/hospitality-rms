'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { archiveSetup } from './actions';

// "Throw away this set-up" (ADR 064) in two taps, like Go live: the first asks, the second
// does it. The draft is kept, archived, out of every list; a company that its Check everything
// already created stays as it is.

export function ThrowAway({
  id,
  name,
  created,
  compact = false,
}: {
  id: string;
  name: string;
  /** Check everything has already created the company. */
  created: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!asking) {
    return (
      <button
        type="button"
        disabled={!hydrated}
        onClick={() => setAsking(true)}
        className={`min-h-11 text-sm text-rose-700 underline ${compact ? 'px-3' : ''}`}
        aria-label={`Throw away the set-up of ${name}`}
      >
        {compact ? 'Throw away' : 'Throw away this set-up'}
      </button>
    );
  }
  return (
    <div
      role="group"
      aria-label="Throw away this set-up?"
      className="space-y-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-900"
    >
      <p>
        Throw away the set-up of {name}? Its choices are gone from this list.
        {created && ' The company it already created stays; suspend it from its page.'}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => setAsking(false)}
          className="min-h-11 rounded-lg bg-white font-medium ring-1 ring-slate-300"
        >
          Keep it
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await archiveSetup(id);
              if (!r.ok) {
                setError(r.message);
                return;
              }
              router.push('/platform');
              router.refresh();
            })
          }
          className="min-h-11 rounded-lg bg-rose-700 font-medium text-white"
        >
          Yes, throw it away
        </button>
      </div>
      <ErrorBox message={error} />
    </div>
  );
}
