'use client';

import { useState } from 'react';
import { PHOTO_MAX_SIDE, PHOTO_QUALITY, resizePhoto } from '@/lib/photo-resize';
import { useHydrated } from '@/lib/use-hydrated';
import { getComplianceUploadUrl } from './actions';

export const MAX_DOCUMENTS = 5;

export interface DocumentFile {
  key: string;
  name: string;
}

/**
 * A licence's or a done job's documents (ADR 069), as a bill's (ADR 050): photos are shrunk on
 * the phone; a PDF goes up as it is (10 MB at most). Straight to S3 with a presigned POST,
 * under the outlet that ops.compliance_upload_place() names for `node`.
 */
export function DocumentFiles({
  node,
  files,
  onChange,
  onError,
  onBusy,
  label = 'Photo or PDF',
}: {
  node: string;
  files: DocumentFile[];
  onChange: (files: DocumentFile[]) => void;
  onError: (message: string | null) => void;
  onBusy?: (busy: boolean) => void;
  label?: string;
}) {
  const hydrated = useHydrated();
  const [uploading, setUploading] = useState(false);
  const busy = (b: boolean) => {
    setUploading(b);
    onBusy?.(b);
  };

  const upload = async (list: FileList) => {
    onError(null);
    busy(true);
    let next = files;
    try {
      for (const file of Array.from(list).slice(0, MAX_DOCUMENTS - files.length)) {
        const pdf = file.type === 'application/pdf';
        const blob = pdf ? file : await resizePhoto(file, PHOTO_MAX_SIDE, PHOTO_QUALITY);
        const type = pdf ? 'application/pdf' : 'image/jpeg';
        const target = await getComplianceUploadUrl(node, type, blob.size);
        if (!target.ok) throw new Error(target.message);
        const form = new FormData();
        for (const [k, v] of Object.entries(target.data.fields)) form.append(k, v);
        form.append('file', blob);
        const res = await fetch(target.data.url, { method: 'POST', body: form });
        if (!res.ok) throw new Error(`${file.name} did not upload. Try again.`);
        next = [...next, { key: target.data.key, name: pdf ? file.name : 'Photo' }];
        onChange(next);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : 'The file did not upload. Try again.');
    } finally {
      busy(false);
    }
  };

  return (
    <div className="space-y-2">
      <span className="text-sm font-medium">{label}</span>
      {files.length > 0 && (
        <ul className="space-y-1 text-sm" data-testid="document-files">
          {files.map((f, i) => (
            <li
              key={f.key}
              className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2"
            >
              <span className="truncate">
                {i + 1}. {f.name}
              </span>
              <button
                type="button"
                className="min-h-11 px-2 text-slate-600"
                aria-label={`Remove ${f.name}`}
                onClick={() => onChange(files.filter((x) => x.key !== f.key))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length < MAX_DOCUMENTS && (
        <label className="flex min-h-12 cursor-pointer items-center justify-center rounded-lg border border-dashed border-slate-400 text-sm font-medium">
          {uploading
            ? 'Uploading…'
            : files.length === 0
              ? 'Take a photo or choose a PDF'
              : 'Add another page'}
          <input
            type="file"
            accept="image/*,application/pdf"
            multiple
            className="sr-only"
            aria-label="Document photo or PDF"
            disabled={uploading || !hydrated}
            onChange={(e) => {
              if (e.target.files?.length) void upload(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      )}
    </div>
  );
}
