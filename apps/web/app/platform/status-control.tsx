'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { setCustomerStatus } from './actions';

/** Pause (every session and sign-in of the customer ends) or resume, with a reason. */
export function StatusControl({
  tenantId,
  status,
  name,
}: {
  tenantId: string;
  status: 'active' | 'suspended';
  name: string;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const next = status === 'active' ? 'suspended' : 'active';
  return (
    <form
      aria-label={`${status === 'active' ? 'Pause' : 'Resume'} ${name}`}
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const r = await setCustomerStatus(tenantId, next, reason);
          if (!r.ok) setError(r.message);
          else {
            setReason('');
            router.refresh();
          }
        });
      }}
    >
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why (kept in the record)"
        aria-label="Why"
        required
        maxLength={300}
        className={`${inputClass} min-h-11 text-sm`}
      />
      <button
        type="submit"
        disabled={!hydrated || pending}
        className="min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium ring-1 ring-slate-300 disabled:opacity-50"
      >
        {status === 'active' ? 'Pause' : 'Resume'}
      </button>
      <ErrorBox message={error} />
    </form>
  );
}
