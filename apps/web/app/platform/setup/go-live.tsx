'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { ErrorBox, primaryButton, StatusBox } from '@/components/messages';
import { usePolling } from '@/components/use-polling';
import { useHydrated } from '@/lib/use-hydrated';
import { advanceSetup, applySetup, checkSetup, sendSetupLogins } from './actions';

// Go live (ADR 064) in two taps: "Check everything" creates the customer and dry runs its
// files; "Looks right" applies them and sends logins. In between the page follows the worker.

export type Stage =
  | { kind: 'blocked' }
  | { kind: 'ready' }
  | { kind: 'busy'; label: string; advance?: boolean }
  | { kind: 'checked'; changes: number }
  | { kind: 'recheck'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'live' };

function Poll() {
  usePolling(2000);
  return null;
}

export function GoLive({ id, stage }: { id: string; stage: Stage }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const once = useRef<string | null>(null);

  const act = (fn: () => Promise<{ ok: true } | { ok: false; message: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.message);
      router.refresh();
    });

  // moves on by itself: the dry run once the customer exists; logins once applied
  useEffect(() => {
    const due =
      stage.kind === 'busy' && stage.advance ? 'advance' : stage.kind === 'live' ? 'logins' : null;
    if (!due || once.current === due) return;
    once.current = due;
    void (async () => {
      if (due === 'advance') {
        const r = await advanceSetup(id);
        if (!r.ok) setError(r.message);
        router.refresh();
        return;
      }
      const r = await sendSetupLogins(id);
      if (!r.ok) setError(r.message);
      else setStatus('Invitations are on their way to the owner and everyone with an email.');
    })();
  }, [id, stage, router]);

  return (
    <div className="space-y-2" data-testid="go-live" data-stage={stage.kind}>
      {stage.kind === 'busy' && (
        <>
          <Poll />
          <p className="font-medium">{stage.label}</p>
        </>
      )}
      {stage.kind === 'blocked' && (
        <p className="text-sm text-slate-600">Fix what is listed above first.</p>
      )}
      {stage.kind === 'ready' && (
        <>
          <p className="text-sm text-slate-600">
            This creates the company and checks everything. Nothing reaches anyone until you apply
            it.
          </p>
          <button
            type="button"
            disabled={!hydrated || pending}
            className={primaryButton}
            onClick={() => act(() => checkSetup(id))}
          >
            Check everything
          </button>
        </>
      )}
      {stage.kind === 'checked' && (
        <>
          <p className="font-medium" data-testid="checked">
            All checked: {stage.changes} things to set up, no problems.
          </p>
          <button
            type="button"
            disabled={!hydrated || pending}
            className={primaryButton}
            onClick={() => act(() => applySetup(id))}
          >
            Looks right: apply and send logins
          </button>
        </>
      )}
      {stage.kind === 'recheck' && (
        <>
          <p className="text-sm">
            {stage.message || 'Fix what is listed above, then check again.'}
          </p>
          <button
            type="button"
            disabled={!hydrated || pending}
            className={primaryButton}
            onClick={() => act(() => checkSetup(id))}
          >
            Check again
          </button>
        </>
      )}
      {stage.kind === 'failed' && (
        <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">
          {stage.message}
        </p>
      )}
      {stage.kind === 'live' && (
        <p className="font-medium text-emerald-800" data-testid="live">
          Live. The company, its outlets and people are set up.
        </p>
      )}
      <StatusBox message={status} />
      <ErrorBox message={error} />
    </div>
  );
}
