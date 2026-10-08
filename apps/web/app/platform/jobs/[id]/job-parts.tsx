'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton, StatusBox } from '@/components/messages';
import { usePolling } from '@/components/use-polling';
import { useHydrated } from '@/lib/use-hydrated';
import { applyImport, inviteOwner } from '../../actions';

export function JobPoller() {
  usePolling(2000);
  return null;
}

export function InviteOwner({ jobId, email }: { jobId: string; email: string }) {
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <p className="text-sm">
        The customer is created. Their first account owner is <strong>{email}</strong>; they sign in
        with that email.
      </p>
      <button
        type="button"
        disabled={!hydrated || pending}
        className={primaryButton}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await inviteOwner(jobId);
            if (r.ok) setStatus(`Invitation sent to ${r.data}.`);
            else setError(r.message);
          })
        }
      >
        Send the owner&apos;s invitation
      </button>
      <StatusBox message={status} />
      <ErrorBox message={error} />
    </div>
  );
}

/** Load after a clean check: a new job that loads the same upload. */
export function ApplyImport({ dryRunJobId }: { dryRunJobId: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={!hydrated || pending}
        className={primaryButton}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await applyImport(dryRunJobId);
            if (r.ok) router.push(`/platform/jobs/${r.data}`);
            else setError(r.message);
          })
        }
      >
        Load these changes
      </button>
      <p className="text-xs text-slate-500">
        Safe to repeat: anything already loaded stays as it is.
      </p>
      <ErrorBox message={error} />
    </div>
  );
}
