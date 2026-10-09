'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, secondaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { closePack } from '@/app/(app)/stock/actions';

/**
 * An opened pack's ending (ADR 093): used up (nothing leaves the store), or thrown away as
 * expired wastage, by the usual wastage rules.
 */
export function PackButtons({ pack, expired }: { pack: string; expired: boolean }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (thrown: boolean) =>
    start(async () => {
      setError(null);
      const r = await closePack(pack, thrown);
      if (!r.ok) setError(r.message);
      else router.refresh();
    });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-end gap-2">
        {!expired && (
          <button
            type="button"
            disabled={!hydrated || pending}
            onClick={() => act(false)}
            className={secondaryButton}
          >
            Used up
          </button>
        )}
        <button
          type="button"
          disabled={!hydrated || pending}
          onClick={() => act(true)}
          className={secondaryButton}
        >
          Throw away
        </button>
      </div>
      <ErrorBox message={error} />
    </div>
  );
}
