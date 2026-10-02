'use client';

import { useState, useTransition } from 'react';
import { reportExpired } from '@/app/(app)/tasks/actions';
import { useHydrated } from '@/lib/use-hydrated';

/**
 * Tells the department head (or the outlet manager) about an expired batch; they give the
 * discard, and maybe a remake, to someone (ADR 020). Reporting twice is harmless.
 */
export function ReportExpired({
  store,
  item,
  batchNo,
}: {
  store: string;
  item: string;
  batchNo: string;
}) {
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  if (state?.ok) {
    return (
      <span role="status" className="shrink-0 text-xs font-medium text-emerald-800">
        {state.text}
      </span>
    );
  }
  return (
    <span className="flex shrink-0 flex-col items-end">
      <button
        type="button"
        disabled={!hydrated || pending}
        className="min-h-11 rounded-lg bg-amber-900 px-3 text-sm font-medium text-white disabled:opacity-50"
        onClick={() =>
          start(async () => {
            const r = await reportExpired(store, item, batchNo);
            setState(r.ok ? { ok: true, text: 'Reported' } : { ok: false, text: r.message });
          })
        }
      >
        Report
      </button>
      {state && !state.ok && (
        <span role="alert" className="text-xs text-rose-800">
          {state.text}
        </span>
      )}
    </span>
  );
}
