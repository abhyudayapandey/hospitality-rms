'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { collectStaffAsk } from '../../actions';

/** Whoever asked: it is with the department now (ADR 142). One tap, no stock moves. */
export function CollectButton({ ask, department }: { ask: string; department: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="space-y-2" data-testid="collect">
      <ErrorBox message={error} />
      <button
        type="button"
        disabled={!hydrated || pending}
        className={primaryButton}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await collectStaffAsk(ask);
            if (r.ok) router.refresh();
            else setError(r.message);
          })
        }
      >
        Transfer to {department} done
      </button>
    </section>
  );
}
