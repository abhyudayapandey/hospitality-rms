'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { ErrorBox, primaryButton, StatusBox } from '@/components/messages';
import { formatTime } from '@/lib/dates';
import { thisDevice } from '@/lib/device';
import { currentPosition } from '@/lib/geo';
import { shrinkSelfie, uploadSelfie } from '@/lib/selfie-upload';
import { formatDuration } from '@/lib/timeline';
import {
  indexedDbStore,
  pending as queued,
  QUEUE_EVENT,
  type QueuedPunch,
} from '@/lib/punch-queue';
import { clock, type PunchInput } from '../actions';
import { useHydrated } from '@/lib/use-hydrated';

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
  // the camera opens only once the page is live (ADR 055)
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<QueuedPunch[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

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

  // The clock-in selfie (ATT-7, ADR 045): the camera opens when "Clock in" is tapped, the
  // punch follows the photo. A phone with no camera clocks in without one and is flagged.
  // It is the live front camera, taken here: never a photo from the gallery (ADR 076).
  const [shooting, setShooting] = useState(false);

  const punch = (photo: Blob | null) =>
    start(async () => {
      setError(null);
      const clientTs = new Date().toISOString(); // the moment of the tap
      setStatus('Getting your location…');
      const pos = await currentPosition();
      const device = thisDevice();
      let selfie: Blob | null = null;
      if (action === 'in' && photo) {
        try {
          selfie = await shrinkSelfie(photo);
        } catch {
          selfie = null; // the photo could not be read: clock in, flagged
        }
      }
      const p: QueuedPunch = {
        idempotencyKey: crypto.randomUUID(),
        userId,
        action,
        ...pos,
        clientTs,
        ...(action === 'in' ? { ...device, selfie } : {}),
      };
      // keep order: while older punches wait, queue this one behind them
      if (!navigator.onLine || waiting.length > 0) return save(p);
      let selfieKey: string | null = null;
      if (selfie) {
        try {
          selfieKey = await uploadSelfie(selfie);
        } catch {
          return save(p); // no connection to upload: keep the selfie on the phone
        }
        // selfies are off here: clock in without one, flagged
      }
      let r;
      try {
        r = await clock({
          action: p.action,
          lat: p.lat,
          lng: p.lng,
          accuracy: p.accuracy,
          clientTs: p.clientTs,
          idempotencyKey: p.idempotencyKey,
          source: 'online',
          deviceId: p.deviceId ?? null,
          deviceModel: p.deviceModel ?? null,
          selfieKey,
        });
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
      const noSelfie = r.data.flags.includes('no_selfie') ? ' No selfie was taken.' : '';
      setStatus(`Clocked ${action} at ${when}.${note}${noSelfie}`);
      router.refresh();
    });

  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-white p-6 text-center ring-1 ring-slate-200">
        <p className="text-sm text-slate-600" data-testid="clock-state">
          {inSince
            ? `Clocked in since ${formatTime(inSince, tz)}, ${formatDuration(
                Math.max(0, Math.floor((now - new Date(inSince).getTime()) / 60_000)),
              )}`
            : 'Not clocked in'}
        </p>
        {waiting.length > 0 && (
          <p className="mt-1 text-xs text-amber-700" data-testid="clock-waiting">
            {waiting.length} punch{waiting.length === 1 ? '' : 'es'} waiting to sync
          </p>
        )}
      </div>
      {shooting ? (
        <SelfieCamera
          onPhoto={(b) => {
            setShooting(false);
            punch(b);
          }}
          onCancel={() => setShooting(false)}
          onFail={() => {
            setShooting(false);
            setError(
              'The camera did not open. Allow the camera for Outlet Ops and try again, or clock in without a selfie (your manager will check it).',
            );
          }}
        />
      ) : (
        <button
          type="button"
          disabled={!hydrated || pending}
          onClick={() => {
            setError(null);
            if (action === 'in') setShooting(true);
            else punch(null);
          }}
          className={`${primaryButton} min-h-16 text-lg`}
        >
          {pending ? 'Working…' : inSince ? 'Clock out' : 'Clock in with a selfie'}
        </button>
      )}
      {action === 'in' && !shooting && (
        <button
          type="button"
          disabled={pending}
          onClick={() => punch(null)}
          data-testid="clock-no-selfie"
          className="min-h-11 w-full text-sm text-slate-600 underline"
        >
          No camera? Clock in without a selfie
        </button>
      )}
      <ErrorBox message={error} />
      <StatusBox message={status} />
      <p className="text-xs text-slate-500">
        Your location is used only to check you are at the outlet. It is kept for 90 days.
      </p>
    </div>
  );
}

/** The front camera, live: the person looks at it and takes the photo here (ADR 076). */
function SelfieCamera({
  onPhoto,
  onCancel,
  onFail,
}: {
  onPhoto: (photo: Blob) => void;
  onCancel: () => void;
  onFail: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  // the camera opens once, whatever the parent does meanwhile
  const fail = useRef(onFail);
  useEffect(() => {
    fail.current = onFail;
  }, [onFail]);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let gone = false;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        });
        if (gone) return stream.getTracks().forEach((t) => t.stop());
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play();
        }
      } catch {
        if (!gone) fail.current();
      }
    })();
    return () => {
      gone = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const take = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')?.drawImage(v, 0, 0);
    c.toBlob((b) => (b ? onPhoto(b) : onFail()), 'image/jpeg', 0.8);
  };

  return (
    <div className="space-y-2" data-testid="selfie-camera">
      <video
        ref={video}
        playsInline
        muted
        onLoadedData={() => setReady(true)}
        className="aspect-[3/4] w-full -scale-x-100 rounded-xl bg-slate-900 object-cover"
        aria-label="Camera"
      />
      <button
        type="button"
        disabled={!ready}
        onClick={take}
        className={`${primaryButton} min-h-16 text-lg`}
      >
        Take photo and clock in
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="min-h-11 w-full text-sm text-slate-600 underline"
      >
        Cancel
      </button>
    </div>
  );
}
