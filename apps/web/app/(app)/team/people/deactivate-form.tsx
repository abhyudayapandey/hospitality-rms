'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, StatusBox } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { requestDeactivation } from '../../roster/actions';

/** Asks for a person to be deactivated (UX-5); the security admin approves. */
export function DeactivateForm({ user, name }: { user: string; name: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  return (
    <details className="text-sm">
      <summary className="min-h-11 cursor-pointer content-center text-slate-600">
        Deactivate
      </summary>
      <div className="space-y-2 pt-1">
        <input
          aria-label={`Why deactivate ${name}`}
          placeholder="Why (for example, left the company)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={inputClass}
        />
        <ErrorBox message={error} />
        <StatusBox message={done} />
        <button
          type="button"
          disabled={!hydrated || pending || !reason.trim()}
          className="min-h-11 w-full rounded-lg border border-rose-300 bg-white font-medium text-rose-800 disabled:opacity-50"
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await requestDeactivation(user, reason, key);
              if (!r.ok) return setError(r.message);
              setDone('Sent for approval.');
              router.refresh();
            })
          }
        >
          Ask to deactivate {name}
        </button>
      </div>
    </details>
  );
}
