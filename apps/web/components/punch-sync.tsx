'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clock } from '@/app/(app)/roster/actions';
import { indexedDbStore, QUEUE_EVENT, replay, type SendOutcome } from '@/lib/punch-queue';

/**
 * Replays offline clock-in/out punches for the signed-in user: on load, when the device
 * comes back online, when a punch is queued, and every minute while any are waiting.
 */
export function PunchSync({ userId }: { userId: string }) {
  const router = useRouter();
  const running = useRef(false);
  const [refused, setRefused] = useState<string[]>([]);

  const run = useCallback(async () => {
    if (running.current || !('indexedDB' in window) || !navigator.onLine) return;
    running.current = true;
    try {
      const r = await replay(indexedDbStore, userId, async (p): Promise<SendOutcome> => {
        try {
          const res = await clock({ ...p, source: 'offline' });
          if (res.ok) return { kind: 'ok' };
          return res.code === 'UNEXPECTED'
            ? { kind: 'unreachable' }
            : { kind: 'refused', message: res.message };
        } catch {
          return { kind: 'unreachable' }; // still no connection
        }
      });
      if (r.refused.length) setRefused((x) => [...x, ...r.refused.map((f) => f.message)]);
      if (r.sent || r.refused.length) {
        window.dispatchEvent(new Event(QUEUE_EVENT));
        router.refresh();
      }
    } catch {
      // IndexedDB unavailable (private mode): nothing was queued either
    } finally {
      running.current = false;
    }
  }, [router, userId]);

  useEffect(() => {
    void run();
    const onChange = () => void run();
    window.addEventListener('online', onChange);
    window.addEventListener(QUEUE_EVENT, onChange);
    const timer = setInterval(onChange, 60_000);
    return () => {
      window.removeEventListener('online', onChange);
      window.removeEventListener(QUEUE_EVENT, onChange);
      clearInterval(timer);
    };
  }, [run]);

  if (refused.length === 0) return null;
  return (
    <div role="alert" className="mx-4 mt-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-800">
      An offline clock punch could not be saved: {refused.join(' ')} Tell your manager.
      <button type="button" onClick={() => setRefused([])} className="ml-2 underline">
        Dismiss
      </button>
    </div>
  );
}
