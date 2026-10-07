'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { markJobDone, renewLicence } from './actions';
import { DocumentFiles, type DocumentFile } from './document-files';

/** A form field's text (a file input gives none). */
const field = (f: FormData, name: string) => {
  const v = f.get(name);
  return typeof v === 'string' ? v : '';
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Renews a licence (ADR 069): the new number (if it changed), dates and the renewed licence
 * itself. The old one is kept as history. On the licence's page for its keepers, and on the
 * renewal's To do item for whoever it is with.
 */
export function RenewForm({
  licence,
  node,
  number,
  photos,
  done,
}: {
  licence: string;
  node: string;
  number: string | null;
  photos: boolean;
  /** where to go once renewed; "{id}" becomes the renewed licence's id */
  done: string;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<DocumentFile[]>([]);
  return (
    <form
      aria-label="Renew the licence"
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        start(async () => {
          setError(null);
          const r = await renewLicence({
            id: licence,
            number: field(f, 'number'),
            issued_on: field(f, 'issued_on') || null,
            expires_on: field(f, 'expires_on'),
            files: files.map((x) => x.key),
          });
          if (!r.ok) {
            setError(r.message);
            return;
          }
          router.push(done.replace('{id}', r.data.id));
          router.refresh();
        });
      }}
    >
      <h2 className="font-semibold">Renew it</h2>
      <label className="block text-sm font-medium">
        Number
        <input name="number" defaultValue={number ?? ''} className={inputClass} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm font-medium">
          Issued on
          <input name="issued_on" type="date" defaultValue={today()} className={inputClass} />
        </label>
        <label className="block text-sm font-medium">
          New expiry
          <input name="expires_on" type="date" required className={inputClass} />
        </label>
      </div>
      {photos ? (
        <DocumentFiles
          node={node}
          files={files}
          onChange={setFiles}
          onError={setError}
          onBusy={setBusy}
          label="The renewed licence (photo or PDF)"
        />
      ) : (
        <p className="text-sm text-slate-600">
          Uploads are off here: the renewed licence can&apos;t be added.
        </p>
      )}
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending || busy} className={primaryButton}>
        Save the renewal
      </button>
    </form>
  );
}

/**
 * Marks a calendar job done (ADR 069): when, the report or certificate where the job asks for
 * one, and a note. The next due date moves on by the job's months from the day it was done.
 */
export function DoneForm({
  job,
  node,
  needsProof,
  photos,
  done,
}: {
  job: string;
  node: string;
  needsProof: boolean;
  photos: boolean;
  /** where to go once marked; stays (refreshed) when absent */
  done?: string;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<DocumentFile[]>([]);
  return (
    <form
      aria-label="Mark it done"
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        start(async () => {
          setError(null);
          const r = await markJobDone({
            id: job,
            done_on: field(f, 'done_on'),
            files: files.map((x) => x.key),
            note: field(f, 'note'),
          });
          if (!r.ok) {
            setError(r.message);
            return;
          }
          const next = new Date(`${r.data.next_due}T00:00:00Z`).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
          });
          setStatus(`Done. Next due ${next}.`);
          if (done) router.push(done);
          router.refresh();
        });
      }}
    >
      <h2 className="font-semibold">Mark it done</h2>
      <label className="block text-sm font-medium">
        Done on
        <input name="done_on" type="date" required defaultValue={today()} className={inputClass} />
      </label>
      {photos ? (
        <DocumentFiles
          node={node}
          files={files}
          onChange={setFiles}
          onError={setError}
          onBusy={setBusy}
          label={needsProof ? 'The report or certificate (needed)' : 'A photo or PDF (optional)'}
        />
      ) : (
        needsProof && (
          <p className="text-sm text-slate-600">
            Uploads are off here: the report or certificate can&apos;t be added.
          </p>
        )
      )}
      <label className="block text-sm font-medium">
        Note (optional)
        <input name="note" maxLength={300} className={inputClass} />
      </label>
      <StatusBox message={status} />
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending || busy} className={primaryButton}>
        Mark done
      </button>
    </form>
  );
}
