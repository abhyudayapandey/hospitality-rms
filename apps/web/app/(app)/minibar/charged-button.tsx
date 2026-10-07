'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, secondaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { markMinibarCharged } from './actions';

/** Front Office: the minibar charge is on the guest's bill. */
export function ChargedButton({ id }: { id: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={!hydrated || pending}
        className={secondaryButton}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await markMinibarCharged(id);
            if (!r.ok) return setError(r.message);
            router.refresh();
          })
        }
      >
        Added to the bill
      </button>
      <ErrorBox message={error} />
    </>
  );
}
