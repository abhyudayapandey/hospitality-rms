'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton, secondaryButton, StatusBox } from '@/components/messages';
import { actOnRequest } from '@/app/(app)/inbox/actions';

export function AdjustmentDecision({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const act = (action: 'approve' | 'reject') =>
    start(async () => {
      setError(null);
      const r = await actOnRequest(requestId, action, crypto.randomUUID());
      if (r.ok) {
        setDone(action === 'approve' ? 'Approved' : 'Rejected');
        setTimeout(() => router.push('/inbox'), 1200);
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
            Approve
          </button>
        </div>
      )}
    </div>
  );
}
