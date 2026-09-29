'use client';

import { useState } from 'react';
import { ErrorBox } from '@/components/messages';
import { getWastageUploadUrl } from '../actions';

// Takes or picks a photo, shrinks it on the phone (long side 1600 px, JPEG) so it
// uploads quickly on a slow network, then posts it straight to S3 with a presigned POST.
async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('resize failed'))), 'image/jpeg', 0.8),
  );
}

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
      const blob = await shrink(file);
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
