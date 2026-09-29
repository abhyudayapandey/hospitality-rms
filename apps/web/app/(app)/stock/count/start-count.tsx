'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton } from '@/components/messages';
import { startCount } from '../actions';

export function StartCountButton({ node }: { node: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        className={primaryButton}
        onClick={() =>
          start(async () => {
            const r = await startCount(node);
            if (r.ok) router.push(`/stock/count/${r.data.id}?node=${node}`);
            else setError(r.message);
          })
        }
      >
        Start a count
      </button>
      <ErrorBox message={error} />
    </div>
  );
}
