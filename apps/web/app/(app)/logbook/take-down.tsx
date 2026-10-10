'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { takeDownLog } from './actions';

export function TakeDown({ entry }: { entry: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <button
        type="button"
        disabled={!hydrated || pending}
        className="min-h-11 text-sm text-slate-600 underline"
        onClick={() =>
          start(async () => {
            const r = await takeDownLog(entry);
            if (!r.ok) setError(r.message);
            else router.refresh();
          })
        }
      >
        Take it down
      </button>
      <ErrorBox message={error} />
    </span>
  );
}
