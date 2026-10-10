'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Initials } from '@/components/initials';
import type { InboxEntry } from '@/lib/inbox';
import { actOnRequest } from './actions';

/** One request; `compact` on Home: who and what, then No and Approve (UX-6). */
export function InboxItem({ entry, compact = false }: { entry: InboxEntry; compact?: boolean }) {
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
      className={
        compact
          ? 'py-3 first:pt-0 last:pb-0'
          : 'rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200'
      }
      data-testid="inbox-item"
      data-request-id={entry.requestId}
    >
      <div className="flex items-start gap-3">
        {/* who asked, as a face (ADR 108); Home's compact rows stay as they are */}
        {!compact && <Initials name={entry.from} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-medium">{entry.processLabel}</p>
            {entry.amount && <p className="font-semibold tabular-nums">{entry.amount}</p>}
          </div>
          <p className="text-sm text-slate-600">
            {compact
              ? `${entry.from} · ${entry.waitingSince}`
              : `${entry.from} · ${entry.stepLabel} · waiting since ${entry.waitingSince}`}
          </p>
        </div>
      </div>
      {entry.items && (
        <p className="mt-1 text-sm text-slate-700" data-testid="inbox-items">
          {entry.items}
        </p>
      )}
      {entry.why && (
        <p className="mt-1 text-sm text-slate-700" data-testid="inbox-why">
          Needs your approval: {entry.why}.
        </p>
      )}
      {entry.link && (
        <Link
          href={entry.link.href}
          className={`mt-3 flex min-h-12 items-center justify-center rounded-lg font-medium ${
            entry.inline ? 'text-slate-700 underline' : 'bg-brand-700 text-white'
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
            className="min-h-12 rounded-lg bg-brand-700 font-medium text-white disabled:opacity-50"
          >
            Approve
          </button>
        </div>
      )}
    </li>
  );
}
