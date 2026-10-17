'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { recordCheckLine } from '@/app/(app)/stock/check/actions';
import { recordWastage } from '@/app/(app)/stock/actions';
import {
  ACTION_QUEUE_EVENT,
  discardPending,
  indexedDbActions,
  pending,
  replay,
  type QueuedAction,
  type SendOutcome,
} from '@/lib/action-queue';

type Result = { ok: true } | { ok: false; code: string; message: string };

async function send(a: QueuedAction): Promise<SendOutcome> {
  try {
    const res: Result =
      a.kind === 'check_line'
        ? await recordCheckLine({
            check: a.check,
            item: a.item,
            counted: a.counted,
            full: a.full,
            tenths: a.tenths,
            area: a.area,
            device: a.device,
            photoKey: a.photoKey,
            countedAt: a.clientTs, // the time it was counted, not the time it syncs (INV-8)
          })
        : await recordWastage(a.node, a.lines, a.idempotencyKey, a.clientTs);
    if (res.ok) return { kind: 'ok' };
    // the server failed it: try it again later, without holding up the rest (ADR 169)
    return res.code === 'UNEXPECTED'
      ? { kind: 'failed' }
      : { kind: 'refused', message: res.message };
  } catch {
    return { kind: 'unreachable' }; // still no connection
  }
}

/**
 * Replays offline stock counts and wastage for the signed-in user: on load, when the device
 * comes back online, when something is queued, and every minute while any are waiting.
 */
export function ActionSync({ userId }: { userId: string }) {
  const router = useRouter();
  const running = useRef(false);
  const [refused, setRefused] = useState<string[]>([]);
  // saved items the server has failed at least once: the person may discard them
  const [stuck, setStuck] = useState(0);
  const [confirming, setConfirming] = useState(false);

  const run = useCallback(async () => {
    if (running.current || !('indexedDB' in window) || !navigator.onLine) return;
    running.current = true;
    try {
      const r = await replay(indexedDbActions, userId, send);
      if (r.refused.length) setRefused((x) => [...x, ...r.refused.map((f) => f.message)]);
      if (r.sent || r.refused.length) {
        window.dispatchEvent(new Event(ACTION_QUEUE_EVENT));
        router.refresh();
      }
      setStuck((await pending(indexedDbActions, userId)).filter((a) => a.tries).length);
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
    window.addEventListener(ACTION_QUEUE_EVENT, onChange);
    const timer = setInterval(onChange, 60_000);
    return () => {
      window.removeEventListener('online', onChange);
      window.removeEventListener(ACTION_QUEUE_EVENT, onChange);
      clearInterval(timer);
    };
  }, [run]);

  const discard = async () => {
    try {
      await discardPending(indexedDbActions, userId);
    } catch {
      // IndexedDB unavailable: nothing to discard
    }
    setStuck(0);
    setConfirming(false);
    window.dispatchEvent(new Event(ACTION_QUEUE_EVENT));
    router.refresh();
  };

  if (refused.length === 0 && stuck === 0) return null;
  return (
    <>
      {refused.length > 0 && (
        <div role="alert" className="mx-4 mt-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-800">
          Something saved on this phone could not be sent: {refused.join(' ')} Tell your manager.
          <button type="button" onClick={() => setRefused([])} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}
      {stuck > 0 && (
        <div
          role="status"
          data-testid="saved-not-sent"
          className="mx-4 mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
        >
          {stuck === 1 ? '1 thing' : `${stuck} things`} saved on this phone did not go through. We
          will try again.{' '}
          {confirming ? (
            <>
              Discard everything saved on this phone?{' '}
              <button
                type="button"
                onClick={() => void discard()}
                className="font-semibold underline"
              >
                Yes, discard
              </button>{' '}
              <button type="button" onClick={() => setConfirming(false)} className="underline">
                Keep
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} className="underline">
              Discard what is saved on this phone
            </button>
          )}
        </div>
      )}
    </>
  );
}
