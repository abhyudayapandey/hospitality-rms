'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { actOnRequest } from './actions';

export interface InboxEntry {
  requestId: string;
  processLabel: string;
  step: string;
  amount: string | null;
  waitingSince: string;
  from: string;
  /** module screen for this request (order, adjustment review, transfer) */
  link?: { href: string; label: string };
  /** show Approve/Reject here (false when the decision belongs on the module screen) */
  inline: boolean;
}

export function InboxItem({ entry }: { entry: InboxEntry }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const router = useRouter();
  const act = (action: 'approve' | 'reject') =>
    start(async () => {
      setError(null);
      const r = await actOnRequest(entry.requestId, action, crypto.randomUUID());
      if (r.ok) {
        setDone(action === 'approve' ? 'Approved' : 'Rejected');
        // Let the confirmation show, then refresh the list and the inbox badge.
        setTimeout(() => router.refresh(), 1500);
      } else {
        setError(r.message);
      }
    });
  return (
    <li
      className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
      data-testid="inbox-item"
      data-request-id={entry.requestId}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-medium">{entry.processLabel}</p>
        {entry.amount && <p className="font-semibold tabular-nums">{entry.amount}</p>}
      </div>
      <p className="text-sm text-slate-600">
        {entry.from} · {entry.step.replace(/_/g, ' ')} · waiting since {entry.waitingSince}
      </p>
      {entry.link && (
        <Link
          href={entry.link.href}
          className={`mt-3 flex min-h-12 items-center justify-center rounded-lg font-medium ${
            entry.inline ? 'text-slate-700 underline' : 'bg-slate-900 text-white'
          }`}
        >
          {entry.link.label}
        </Link>
      )}
      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-rose-50 p-2 text-sm text-rose-800">
          {error}
        </p>
      )}
      {done ? (
        <p role="status" className="mt-3 font-medium text-emerald-700">
          {done}
        </p>
      ) : !entry.inline ? null : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => act('reject')}
            className="min-h-12 rounded-lg border border-slate-300 font-medium disabled:opacity-50"
          >
            Reject
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => act('approve')}
            className="min-h-12 rounded-lg bg-slate-900 font-medium text-white disabled:opacity-50"
          >
            Approve
          </button>
        </div>
      )}
    </li>
  );
}
