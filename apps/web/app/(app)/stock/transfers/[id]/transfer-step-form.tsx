'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import {
  ErrorBox,
  inputClass,
  primaryButton,
  secondaryButton,
  StatusBox,
} from '@/components/messages';
import { actOnRequest } from '@/app/(app)/inbox/actions';
import { dispatchTransfer, receiveTransfer } from '../../actions';

export interface TransferLine {
  item_id: string;
  name: string;
  base_uom: string;
  requested_qty: string;
  dispatched_qty: string | null;
  received_qty: string | null;
}

const n = (v: string | null) => (v === null ? null : Number(v));

/**
 * Dispatch (hub): what is sent, defaulting to the request; Reject is still possible.
 * Receive (outlet): what arrived, defaulting to what was sent; no reject once in transit,
 * any shortfall is recorded as transit loss. Read-only otherwise.
 */
export function TransferStepForm({
  transfer,
  requestId,
  mode,
  lines,
}: {
  transfer: string;
  requestId: string;
  mode: 'dispatch' | 'receive' | 'approve' | null;
  lines: TransferLine[];
}) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      lines.map((l) => [
        l.item_id,
        String(mode === 'receive' ? (n(l.dispatched_qty) ?? 0) : n(l.requested_qty)),
      ]),
    ),
  );
  const [pending, start] = useTransition();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const confirm = () =>
    start(async () => {
      setError(null);
      const payload = lines.map((l) => ({ item_id: l.item_id, qty: Number(qty[l.item_id] || 0) }));
      const r =
        mode === 'dispatch'
          ? await dispatchTransfer(transfer, payload)
          : await receiveTransfer(transfer, payload);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setDone(mode === 'dispatch' ? 'Sent. It is now in transit.' : 'Received.');
      router.refresh();
    });
  const approve = () =>
    start(async () => {
      setError(null);
      const r = await actOnRequest(requestId, 'approve', crypto.randomUUID());
      if (r.ok) {
        setDone('Approved. It goes to the store keeper now.');
        router.refresh();
      } else setError(r.message);
    });
  const reject = () =>
    start(async () => {
      setError(null);
      const r = await actOnRequest(requestId, 'reject', crypto.randomUUID());
      if (r.ok) {
        setDone('Rejected.');
        router.refresh();
      } else setError(r.message);
    });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        confirm();
      }}
    >
      {mode === 'approve' && (
        <p className="rounded-lg bg-violet-50 p-3 text-sm text-violet-900">
          This request is off the menu or more than usual, so it needs your approval before the
          store keeper issues it.
        </p>
      )}
      <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
        {lines.map((l) => (
          <li key={l.item_id} className="flex items-center justify-between gap-3 px-4 py-2">
            <label htmlFor={`q-${l.item_id}`} className="min-w-0 flex-1 text-sm">
              <span className="block font-medium">{l.name}</span>
              <span className="text-xs text-slate-500">
                asked {n(l.requested_qty)}
                {l.dispatched_qty !== null && ` · sent ${n(l.dispatched_qty)}`}
                {l.received_qty !== null && ` · received ${n(l.received_qty)}`} {l.base_uom}
              </span>
            </label>
            {(mode === 'dispatch' || mode === 'receive') && (
              <input
                id={`q-${l.item_id}`}
                aria-label={`${mode === 'dispatch' ? 'Send' : 'Received'} ${l.name}`}
                inputMode="decimal"
                value={qty[l.item_id] ?? ''}
                onChange={(e) => setQty((v) => ({ ...v, [l.item_id]: e.target.value }))}
                className={`${inputClass} max-w-28 text-right`}
              />
            )}
          </li>
        ))}
      </ul>
      <ErrorBox message={error} />
      <StatusBox message={done} />
      {mode === 'approve' && !done && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={pending} onClick={reject} className={secondaryButton}>
            Reject
          </button>
          <button
            type="button"
            disabled={!hydrated || pending}
            onClick={approve}
            className={primaryButton}
          >
            Approve
          </button>
        </div>
      )}
      {(mode === 'dispatch' || mode === 'receive') && !done && (
        <div className={mode === 'dispatch' ? 'grid grid-cols-2 gap-2' : ''}>
          {mode === 'dispatch' && (
            <button type="button" disabled={pending} onClick={reject} className={secondaryButton}>
              Reject
            </button>
          )}
          <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
            {mode === 'dispatch' ? 'Send' : 'Confirm receipt'}
          </button>
        </div>
      )}
    </form>
  );
}
