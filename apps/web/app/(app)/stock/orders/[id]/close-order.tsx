'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, secondaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { closeOrder, withdrawRequest } from '../../actions';

/**
 * "Rest is not coming" (ADR 052): the keeper who receives the order closes it with a reason.
 * What arrived stays; the GM and the department are told. Folded away under the receive form:
 * it is the exception.
 */
export function CloseOrder({ po }: { po: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [reason, setReason] = useState('');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    start(async () => {
      setError(null);
      if (!reason.trim()) {
        setError('Say why the rest is not coming.');
        return;
      }
      const r = await closeOrder(po, reason.trim());
      if (r.ok) router.refresh();
      else setError(r.message);
    });
  return (
    <details className="rounded-xl bg-white p-4 ring-1 ring-slate-200" data-testid="close-order">
      <summary className="min-h-11 cursor-pointer py-2 font-medium">Rest is not coming</summary>
      <form
        className="space-y-3 pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="text-sm text-slate-600">
          Closes the order with what has arrived. The GM and the department are told.
        </p>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Why</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Supplier out of stock"
            className={inputClass}
          />
        </label>
        <ErrorBox message={error} />
        <button type="submit" disabled={!hydrated || pending} className={secondaryButton}>
          Close the order
        </button>
      </form>
    </details>
  );
}

/** Whoever asked withdraws a supply request that nobody has ordered yet (ADR 052). */
export function WithdrawRequest({ po }: { po: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [sure, setSure] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const withdraw = () =>
    start(async () => {
      setError(null);
      const r = await withdrawRequest(po, '');
      if (r.ok) router.refresh();
      else setError(r.message);
    });
  return (
    <div className="space-y-2" data-testid="withdraw">
      <ErrorBox message={error} />
      {sure ? (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setSure(false)} className={secondaryButton}>
            Keep it
          </button>
          <button
            type="button"
            disabled={!hydrated || pending}
            onClick={withdraw}
            className="min-h-12 rounded-lg bg-rose-700 font-medium text-white disabled:opacity-50"
          >
            Withdraw
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setSure(true)}
          className="flex min-h-11 w-full items-center justify-center text-sm font-medium text-rose-700 underline"
        >
          Withdraw this request
        </button>
      )}
    </div>
  );
}
