'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, StatusBox } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { removeTestCustomer, startAgain } from './actions';

/**
 * Start again (ADR 130), test customers only: everything of theirs is removed except the
 * customer itself, its plan and settings. Then their files are imported as for a new customer.
 * With `remove` (ADR 139) the customer goes too: off the list for good, back to the list.
 */
export function StartAgain({
  tenantId,
  name,
  remove = false,
}: {
  tenantId: string;
  name: string;
  remove?: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <form
      aria-label={remove ? `Remove ${name}` : `Start ${name} again`}
      className="space-y-2"
      data-testid={remove ? 'remove-test-customer' : 'start-again'}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          setDone(null);
          const r = await (remove ? removeTestCustomer : startAgain)(tenantId, typed);
          if (!r.ok) return setError(r.message);
          if (remove) return router.push('/platform');
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
        {pending
          ? 'Removing…'
          : remove
            ? `Remove ${name} for good`
            : 'Remove everything and start again'}
      </button>
    </form>
  );
}
