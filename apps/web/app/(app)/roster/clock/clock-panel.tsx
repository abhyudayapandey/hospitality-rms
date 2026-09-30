'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { ErrorBox, primaryButton, StatusBox } from '@/components/messages';
import { formatTime } from '@/lib/dates';
import {
  indexedDbStore,
  pending as queued,
  QUEUE_EVENT,
  type QueuedPunch,
} from '@/lib/punch-queue';
import { clock, type PunchInput } from '../actions';

interface Position {
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
}

/** The device position, or nulls when denied, unavailable or slower than 10 s. */
function currentPosition(): Promise<Position> {
  const none = { lat: null, lng: null, accuracy: null };
  if (!('geolocation' in navigator)) return Promise.resolve(none);
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: Math.round(p.coords.latitude * 1e6) / 1e6,
          lng: Math.round(p.coords.longitude * 1e6) / 1e6,
          accuracy: Math.round(p.coords.accuracy),
        }),
      () => resolve(none),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    ),
  );
}

/**
 * Clock in/out. Online first; with no connection the punch is saved on the phone with its
 * time and synced later by <PunchSync> (ADR 008). While punches wait, the state shown is
 * the server's state plus the waiting punches.
 */
export function ClockPanel({
  clockedInAt,
  tz,
  userId,
}: {
  clockedInAt: string | null;
  tz: string;
  userId: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<QueuedPunch[]>([]);

  const reload = useCallback(() => {
    if (!('indexedDB' in window)) return;
    queued(indexedDbStore, userId)
      .then(setWaiting)
      .catch(() => setWaiting([]));
  }, [userId]);
  useEffect(() => {
    reload();
    window.addEventListener(QUEUE_EVENT, reload);
    return () => window.removeEventListener(QUEUE_EVENT, reload);
  }, [reload]);

  const last = waiting.at(-1);
  const inSince = last ? (last.action === 'in' ? last.clientTs : null) : clockedInAt;
  const action: PunchInput['action'] = inSince ? 'out' : 'in';

  const save = async (p: QueuedPunch) => {
    await indexedDbStore.put(p);
    window.dispatchEvent(new Event(QUEUE_EVENT));
    setStatus(
      `No connection. Clock-${p.action} at ${formatTime(p.clientTs, tz)} is saved on this phone and will sync when you are back online.`,
    );
  };

  const punch = () =>
    start(async () => {
      setError(null);
      const clientTs = new Date().toISOString(); // the moment of the tap
      setStatus('Getting your location…');
      const pos = await currentPosition();
      const p: QueuedPunch = {
        idempotencyKey: crypto.randomUUID(),
        userId,
        action,
        ...pos,
        clientTs,
      };
      // keep order: while older punches wait, queue this one behind them
      if (!navigator.onLine || waiting.length > 0) return save(p);
      let r;
      try {
        r = await clock({ ...p, source: 'online' });
      } catch {
        return save(p); // the request did not get through
      }
      if (!r.ok) {
        setStatus(null);
        setError(r.message);
        return;
      }
      const when = formatTime(action === 'in' ? r.data.clock_in_at : r.data.clock_out_at!, tz);
      const note = r.data.flags.includes('outside_geofence')
        ? ` You were ${Math.round(Number(r.data.distance_m))} m from the outlet, so your manager will check it.`
        : r.data.flags.includes('no_location')
          ? ' Your location was not available, so your manager will check it.'
          : '';
      setStatus(`Clocked ${action} at ${when}.${note}`);
      router.refresh();
    });

  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-white p-6 text-center ring-1 ring-slate-200">
        <p className="text-sm text-slate-600" data-testid="clock-state">
          {inSince ? `Clocked in since ${formatTime(inSince, tz)}` : 'Not clocked in'}
        </p>
        {waiting.length > 0 && (
          <p className="mt-1 text-xs text-amber-700" data-testid="clock-waiting">
            {waiting.length} punch{waiting.length === 1 ? '' : 'es'} waiting to sync
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={punch}
        className={`${primaryButton} min-h-16 text-lg`}
      >
        {pending ? 'Working…' : inSince ? 'Clock out' : 'Clock in'}
      </button>
      <ErrorBox message={error} />
      <StatusBox message={status} />
      <p className="text-xs text-slate-500">
        Your location is used only to check you are at the outlet. It is kept for 90 days.
      </p>
    </div>
  );
}
