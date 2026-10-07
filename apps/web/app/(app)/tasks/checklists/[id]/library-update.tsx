'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, StatusBox } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { adoptLibraryVersion } from '../../actions';

// "A newer version" (ADR 068): the starter library has moved on since this checklist was
// copied. The person who edits it sees what is new beside what they have, and may take the
// new steps; the name, schedule and who it goes to stay theirs.

export interface StepLine {
  label: string;
  range: string | null;
}

export function LibraryUpdate({
  id,
  name,
  current,
  next,
}: {
  id: string;
  name: string;
  current: StepLine[];
  next: StepLine[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const ids = new Set(current.map((s) => s.label));
  const kept = new Set(next.map((s) => s.label));

  return (
    <section
      className="space-y-2 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200"
      data-testid="library-update"
    >
      <p className="font-medium">A newer version of {name} is in the starter library.</p>
      <details>
        <summary className="min-h-11 cursor-pointer py-2 underline">See what&apos;s new</summary>
        <div className="space-y-3">
          <div>
            <p className="font-medium">The new version</p>
            <ol className="list-decimal space-y-1 pl-5" data-testid="library-new">
              {next.map((s, i) => (
                <li key={i}>
                  {s.label}
                  {s.range && <span className="text-amber-800"> ({s.range})</span>}
                  {!ids.has(s.label) && <span className="font-medium"> · new</span>}
                </li>
              ))}
            </ol>
          </div>
          {current.some((s) => !kept.has(s.label)) && (
            <div>
              <p className="font-medium">Not in the new version</p>
              <ul className="list-disc space-y-1 pl-5" data-testid="library-gone">
                {current
                  .filter((s) => !kept.has(s.label))
                  .map((s, i) => (
                    <li key={i}>{s.label}</li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      </details>
      <button
        type="button"
        disabled={!hydrated || pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await adoptLibraryVersion(id);
            if (!r.ok) {
              setError(r.message);
              return;
            }
            setDone('Updated.');
            router.replace(`/tasks/checklists/${id}?updated=${r.data.version}`);
            router.refresh();
          })
        }
        className="min-h-11 w-full rounded-lg bg-white font-medium text-amber-900 ring-1 ring-amber-300"
      >
        Use the new version
      </button>
      <StatusBox message={done} />
      <ErrorBox message={error} />
    </section>
  );
}
