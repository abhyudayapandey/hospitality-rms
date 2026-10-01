'use client';

import { useState } from 'react';
import { ErrorBox } from '@/components/messages';
import { PHOTO_MAX_SIDE, PHOTO_QUALITY, resizePhoto } from '@/lib/photo-resize';
import { getWastageUploadUrl } from '../actions';

// Takes or picks a photo, shrinks it on the phone (lib/photo-resize: long side 1280 px,
// JPEG 0.7) so it uploads quickly on a slow network, then posts it straight to S3 with a
// presigned POST. Expired-batch wastage uses this same form.
export function PhotoField({
  node,
  photoKey,
  onChange,
}: {
  node: string;
  photoKey: string | null;
  onChange: (key: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    onChange(null);
    try {
      const blob = await resizePhoto(file, PHOTO_MAX_SIDE, PHOTO_QUALITY);
      const target = await getWastageUploadUrl(node, 'image/jpeg', blob.size);
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

  return (
    <div className="space-y-2">
      <label className="flex min-h-12 cursor-pointer items-center justify-center rounded-lg border border-dashed border-slate-400 text-sm font-medium">
        {busy ? 'Uploading…' : photoKey ? 'Retake photo' : 'Take a photo'}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
      </label>
      {preview && photoKey && (
        // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
        <img src={preview} alt="Wastage photo" className="max-h-48 rounded-lg" />
      )}
      <ErrorBox message={error} />
    </div>
  );
}
