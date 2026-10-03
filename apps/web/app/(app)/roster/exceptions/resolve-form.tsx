'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass } from '@/components/messages';
import { resolveException } from '../actions';

export function ResolveForm({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = (status: 'resolved' | 'dismissed') =>
    start(async () => {
      setError(null);
      const r = await resolveException(id, status, note);
      if (!r.ok) setError(r.message);
      else router.refresh();
    });
  return (
    <div className="mt-3 space-y-2">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        placeholder="Note (optional)"
        aria-label="Note"
        className={inputClass}
      />
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => act('dismissed')}
          className="min-h-11 rounded-lg text-sm font-medium ring-1 ring-slate-300 disabled:opacity-50"
        >
          Dismiss
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => act('resolved')}
          className="min-h-11 rounded-lg bg-brand-700 text-sm font-medium text-white disabled:opacity-50"
        >
          Resolve
        </button>
      </div>
      <ErrorBox message={error} />
    </div>
  );
}
