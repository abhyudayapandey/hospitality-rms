'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ActionResult } from '@outlet-ops/domain';
import { actOnRequest } from '@/app/(app)/inbox/actions';
import { ErrorBox, primaryButton, secondaryButton, StatusBox } from './messages';

/**
 * Approve / reject buttons for a request's pending step. `approve` replaces the generic
 * wf.act approval for module-approved steps (e.g. hr.approve_swap re-checks the rules).
 */
export function RequestDecision({
  requestId,
  back,
  approve,
  approveLabel = 'Approve',
}: {
  requestId: string;
  back: string;
  approve?: () => Promise<ActionResult<unknown>>;
  /** e.g. "Approve anyway" when the approver has warnings in front of them */
  approveLabel?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const act = (action: 'approve' | 'reject') =>
    start(async () => {
      setError(null);
      const r =
        action === 'approve' && approve
          ? await approve()
          : await actOnRequest(requestId, action, crypto.randomUUID());
      if (r.ok) {
        setDone(action === 'approve' ? 'Approved' : 'Rejected');
        setTimeout(() => router.push(back), 1200);
      } else setError(r.message);
    });
  return (
    <div className="space-y-2">
      <ErrorBox message={error} />
      <StatusBox message={done} />
      {!done && (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => act('reject')}
            className={secondaryButton}
          >
            Reject
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => act('approve')}
            className={primaryButton}
          >
            {approveLabel}
          </button>
        </div>
      )}
    </div>
  );
}
