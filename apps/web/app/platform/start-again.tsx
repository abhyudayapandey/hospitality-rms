'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, StatusBox } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { startAgain } from './actions';

/**
 * Start again (ADR 130), test customers only: everything of theirs is removed except the
 * customer itself, its plan and settings. Then their files are imported as for a new customer.
 */
export function StartAgain({ tenantId, name }: { tenantId: string; name: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <form
      aria-label={`Start ${name} again`}
      className="space-y-2"
      data-testid="start-again"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          setDone(null);
          const r = await startAgain(tenantId, typed);
          if (!r.ok) return setError(r.message);
          setTyped('');
          setDone('Done. Now import their files, then make their logins again.');
          router.refresh();
        });
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm text-slate-600">Type {name} to confirm</span>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          className={`${inputClass} min-h-11 text-sm`}
        />
      </label>
      <ErrorBox message={error} />
      <StatusBox message={done} />
      <button
        type="submit"
        disabled={!hydrated || pending || typed !== name}
        className="min-h-11 w-full rounded-lg bg-rose-700 px-3 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? 'Removing…' : 'Remove everything and start again'}
      </button>
    </form>
  );
}
