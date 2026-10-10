'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { ackSop } from '../../../training/actions';

export function AckButton({ sop }: { sop: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <ErrorBox message={error} />
      <button
        type="button"
        disabled={!hydrated || pending}
        className={primaryButton}
        onClick={() =>
          start(async () => {
            const r = await ackSop(sop);
            if (!r.ok) setError(r.message);
            else router.refresh();
          })
        }
      >
        I&apos;ve read this
      </button>
    </div>
  );
}
