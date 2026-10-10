'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton, StatusBox } from '@/components/messages';
import { formatMoney } from '@/lib/format';
import { useHydrated } from '@/lib/use-hydrated';
import { markMinibarCharged, refillMinibar } from '../../minibar/actions';
import { UsedLines } from '../../minibar/used-lines';

export interface MinibarTaskCheck {
  check_id: string;
  room: string;
  store: string;
  used: { item: string; qty: string; price: string; unit: string }[];
  charge: string;
  charged_at: string | null;
  short: boolean;
}

/**
 * A minibar's refill or bill (ADR 081, 104): what was used in the room, each with its photo and
 * a big ×N; the attendant takes it from the store and marks it refilled, the front desk adds
 * the charge to the guest's bill (the only one who sees the prices).
 */
export function MinibarTask({
  task,
  kind,
  check,
  canWork,
  open,
}: {
  task: string;
  kind: 'minibar_refill' | 'minibar_bill';
  check: MinibarTaskCheck;
  canWork: boolean;
  open: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const act = () =>
    start(async () => {
      setError(null);
      if (kind === 'minibar_refill') {
        const r = await refillMinibar(task);
        if (!r.ok) return setError(r.message);
        if (r.data.short) setStatus('Refilled what the store had. The rest is short there.');
      } else {
        const r = await markMinibarCharged(check.check_id);
        if (!r.ok) return setError(r.message);
      }
      router.refresh();
    });
  return (
    <section
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      data-testid="minibar-task"
    >
      <h2 className="font-semibold">
        {kind === 'minibar_refill' ? (
          <>
            Put back in room {check.room}
            <span className="block text-sm font-normal text-slate-500">from {check.store}</span>
          </>
        ) : (
          `Add to room ${check.room}'s bill`
        )}
      </h2>
      <UsedLines used={check.used} prices={kind === 'minibar_bill'} testId="minibar-used" />
      {kind === 'minibar_bill' && (
        <p className="flex justify-between text-base font-semibold">
          <span>Total</span>
          <span className="tabular-nums" data-testid="minibar-task-charge">
            {formatMoney(check.charge)}
          </span>
        </p>
      )}
      <ErrorBox message={error} />
      <StatusBox message={status} />
      {canWork && open && (
        <button
          type="button"
          className={primaryButton}
          disabled={!hydrated || pending}
          onClick={act}
        >
          {kind === 'minibar_refill' ? 'Refilled' : 'Added to the bill'}
        </button>
      )}
    </section>
  );
}
