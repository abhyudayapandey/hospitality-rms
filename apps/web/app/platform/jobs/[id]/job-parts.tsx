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

export function InviteOwner({
  jobId,
  email,
  username,
}: {
  jobId: string;
  email: string;
  username: string;
}) {
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <p className="text-sm">
        The customer is created. Their first account owner is <strong>{username}</strong> ({email}).
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

/** Apply after a successful dry run: a new job that loads the same upload. */
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
        Apply
      </button>
      <p className="text-xs text-slate-500">
        Applying is safe to repeat: rows that are already loaded stay as they are.
      </p>
      <ErrorBox message={error} />
    </div>
  );
}
