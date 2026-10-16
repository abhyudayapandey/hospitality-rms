'use client';

import { useEffect, useRef, useState } from 'react';
import { ErrorBox, primaryButton } from '@/components/messages';
import { PHOTO_MAX_SIDE, PHOTO_QUALITY, resizePhoto } from '@/lib/photo-resize';
import type { ActionResult } from '@outlet-ops/domain';
import type { UploadTarget } from '@/lib/photo-policy';

/** A server action that checks access in SQL and presigns one upload. */
export type GetUploadUrl = (
  node: string,
  contentType: string,
  size: number,
) => Promise<ActionResult<UploadTarget>>;

// Takes a photo with the live back camera (ADR 127: never one from the gallery, so it shows the
// thing now), shrinks it on the phone (lib/photo-resize: long side 1280 px, JPEG 0.7) so it
// uploads quickly on a slow network, then posts it straight to S3 with a presigned POST. Task
// steps, task photos, maintenance, wastage and stock checks use it, each with its own presign
// action. A dish's or an item's catalogue photo (`gallery`) may also come from the phone's photos.
export function PhotoField({
  node,
  photoKey,
  onChange,
  getUploadUrl,
  label = 'Photo',
  gallery = false,
  photoUrl = null,
}: {
  node: string;
  photoKey: string | null;
  /** where the photo already saved under photoKey shows, coming back to it (ADR 164) */
  photoUrl?: string | null;
  onChange: (key: string | null) => void;
  getUploadUrl: GetUploadUrl;
  label?: string;
  gallery?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);

  const upload = async (file: Blob) => {
    setBusy(true);
    setError(null);
    onChange(null);
    try {
      const blob = await resizePhoto(file, PHOTO_MAX_SIDE, PHOTO_QUALITY);
      const target = await getUploadUrl(node, 'image/jpeg', blob.size);
      if (!target.ok) throw new Error(target.message);
      const form = new FormData();
      for (const [k, v] of Object.entries(target.data.fields)) form.append(k, v);
      form.append('file', blob);
      const res = await fetch(target.data.url, { method: 'POST', body: form });
      if (!res.ok) throw new Error('The photo did not upload. Try again.');
      setPreview(URL.createObjectURL(blob));
      onChange(target.data.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The photo did not upload. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (camera) {
    return (
      <LiveCamera
        onPhoto={(b) => {
          setCamera(false);
          void upload(b);
        }}
        onCancel={() => setCamera(false)}
        onFail={() => {
          setCamera(false);
          setError('Allow the camera for Hey Senior, then try again.');
        }}
      />
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => setCamera(true)}
        data-testid="photo-camera"
        className="flex min-h-12 w-full items-center justify-center rounded-lg border border-dashed border-slate-400 text-sm font-medium"
      >
        {busy ? 'Uploading…' : photoKey ? 'Take it again' : 'Take a photo'}
      </button>
      {gallery && (
        <label className="flex min-h-11 cursor-pointer items-center justify-center text-sm text-slate-600 underline">
          Pick from photos
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
        </label>
      )}
      {(preview ?? photoUrl) && photoKey && (
        // eslint-disable-next-line @next/next/no-img-element -- local object URL or presigned preview
        <img
          src={(preview ?? photoUrl)!}
          alt={label}
          className="max-h-48 rounded-lg"
          data-testid="photo-preview"
        />
      )}
      <ErrorBox message={error} />
    </div>
  );
}

/** The back camera, live: a tap takes the picture. */
function LiveCamera({
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
          video: { facingMode: 'environment' },
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
    c.toBlob((b) => (b ? onPhoto(b) : fail.current()), 'image/jpeg', 0.85);
  };

  return (
    <div className="space-y-2" data-testid="live-camera">
      <video
        ref={video}
        playsInline
        muted
        onLoadedData={() => setReady(true)}
        className="aspect-[3/4] w-full rounded-xl bg-slate-900 object-cover"
        aria-label="Camera"
      />
      <button
        type="button"
        disabled={!ready}
        onClick={take}
        className={`${primaryButton} min-h-14 text-lg`}
      >
        Take photo
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
