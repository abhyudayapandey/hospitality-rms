'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton } from '@/components/messages';
import { startStockCheck } from './actions';

export function StartCheckButtons({ node, resume }: { node: string; resume: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const go = (mode: 'standard' | 'bar') =>
    start(async () => {
      const r = await startStockCheck(node, mode, crypto.randomUUID());
      if (r.ok) router.push(`/stock/check/${r.data.id}?node=${node}`);
      else setError(r.message);
    });
  if (resume) {
    return (
      <button
        type="button"
        className={primaryButton}
        onClick={() => router.push(`/stock/check/${resume}?node=${node}`)}
      >
        Continue the stock check
      </button>
    );
  }
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        className={primaryButton}
        onClick={() => go('standard')}
      >
        Start a stock check
      </button>
      <button
        type="button"
        disabled={pending}
        className="flex min-h-12 w-full items-center justify-center rounded-lg bg-white font-medium ring-1 ring-slate-300"
        onClick={() => go('bar')}
      >
        Start a bar check (bottles and tenths)
      </button>
      <ErrorBox message={error} />
    </div>
  );
}
