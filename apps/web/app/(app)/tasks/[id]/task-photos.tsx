'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton, secondaryButton } from '@/components/messages';
import { PhotoField } from '@/components/photo-field';
import { useHydrated } from '@/lib/use-hydrated';
import { addTaskPhoto, getTaskUploadUrl } from '../actions';

/** Add a photo of the task (ADR 079): three at most; kept 30 days. ops.add_task_photo checks who. */
export function AddTaskPhoto({ task, node }: { task: string; node: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    start(async () => {
      if (!key) return;
      setError(null);
      const r = await addTaskPhoto(task, key);
      if (!r.ok) return setError(r.message);
      setOpen(false);
      setKey(null);
      router.refresh();
    });
  if (!open) {
    return (
      <button
        type="button"
        className={secondaryButton}
        disabled={!hydrated}
        onClick={() => setOpen(true)}
      >
        Add a photo
      </button>
    );
  }
  return (
    <div className="space-y-2" data-testid="task-photo-form">
      <PhotoField
        node={node}
        photoKey={key}
        onChange={setKey}
        getUploadUrl={getTaskUploadUrl}
        label="Photo of the task"
      />
      <ErrorBox message={error} />
      <button
        type="button"
        className={primaryButton}
        disabled={!hydrated || pending || !key}
        onClick={save}
      >
        Save the photo
      </button>
    </div>
  );
}
