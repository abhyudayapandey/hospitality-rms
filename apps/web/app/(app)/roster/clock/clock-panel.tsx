'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton, StatusBox } from '@/components/messages';
import { formatTime } from '@/lib/dates';
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

export function ClockPanel({ clockedInAt, tz }: { clockedInAt: string | null; tz: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const action: PunchInput['action'] = clockedInAt ? 'out' : 'in';

  const punch = () =>
    start(async () => {
      setError(null);
      setStatus('Getting your location…');
      const pos = await currentPosition();
      const input: PunchInput = {
        action,
        ...pos,
        clientTs: new Date().toISOString(),
        source: 'online',
        idempotencyKey: crypto.randomUUID(),
      };
      const r = await clock(input);
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
          {clockedInAt ? `Clocked in since ${formatTime(clockedInAt, tz)}` : 'Not clocked in'}
        </p>
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={punch}
        className={`${primaryButton} min-h-16 text-lg`}
      >
        {pending ? 'Working…' : clockedInAt ? 'Clock out' : 'Clock in'}
      </button>
      <ErrorBox message={error} />
      <StatusBox message={status} />
      <p className="text-xs text-slate-500">
        Your location is used only to check you are at the outlet. It is kept for 90 days.
      </p>
    </div>
  );
}
