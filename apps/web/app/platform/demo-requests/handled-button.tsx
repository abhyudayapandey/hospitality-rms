'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox } from '@/components/messages';
import { markDemoRequestHandled } from '../actions';

/** "Called back": takes the request off the New list. */
export function HandledButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        aria-label={`Mark ${name} as called back`}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await markDemoRequestHandled(id);
            if (!r.ok) setError(r.message);
            else router.refresh();
          })
        }
        className="min-h-11 rounded-lg px-3 text-sm font-medium text-brand-700 ring-1 ring-brand-700 disabled:opacity-60"
      >
        Called back
      </button>
      <ErrorBox message={error} />
    </div>
  );
}
