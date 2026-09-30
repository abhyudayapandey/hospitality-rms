'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, secondaryButton } from '@/components/messages';
import { cancelEvent } from '../../roster/actions';

export function CancelEvent({ id, node }: { id: string; node: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        className={`${secondaryButton} text-rose-700`}
        onClick={() => {
          if (!confirm) return setConfirm(true);
          start(async () => {
            const r = await cancelEvent(id);
            if (!r.ok) setError(r.message);
            else router.push(`/events?node=${node}`);
          });
        }}
      >
        {confirm ? 'Tap again to cancel the event' : 'Cancel event'}
      </button>
      <ErrorBox message={error} />
    </div>
  );
}
