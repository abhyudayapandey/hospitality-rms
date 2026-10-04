'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { messageFor } from '@outlet-ops/domain';
import { PosFileError, readPosFile, type PosFile } from '@outlet-ops/onboarding/pos';
import { ErrorBox, primaryButton, StatusBox } from '@/components/messages';
import { formatMoney } from '@/lib/format';
import { importPos } from '../../actions';

// The file is read here, in the browser, with the same reader the tests use: only its
// lines go to the server, which checks them all again (ADR 039).
export function ImportForm({
  outlet,
  date,
  again,
}: {
  outlet: string;
  date: string;
  again: boolean;
}) {
  const router = useRouter();
  const [file, setFile] = useState<PosFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();

  async function choose(f: File | undefined) {
    setError(null);
    setDone(null);
    setFile(null);
    if (!f) return;
    try {
      setFile(readPosFile(f.name, new Uint8Array(await f.arrayBuffer())));
    } catch (err) {
      setError(err instanceof PosFileError ? messageFor(err.code) : messageFor('POS_FILE_TYPE'));
    }
  }

  return (
    <form
      className="space-y-3 rounded-2xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        if (!file) return;
        start(async () => {
          setError(null);
          setDone(null);
          const r = await importPos(outlet, date, file, key);
          if (!r.ok) {
            setError(r.message);
            return;
          }
          const n = r.data.unmatched.length;
          setDone(
            `Imported: ${r.data.posted} ${r.data.posted === 1 ? 'item' : 'items'}${
              n > 0 ? `, ${n} not matched yet` : ''
            }. Stock is updated.`,
          );
          setFile(null);
          setKey(crypto.randomUUID());
          router.refresh();
        });
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium">
          {again ? 'Import the day again' : "The POS's Sale by item file"}
        </span>
        <input
          type="file"
          name="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          data-testid="pos-file"
          className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-brand-50 file:px-4 file:font-medium file:text-brand-700"
          onChange={(e) => void choose(e.target.files?.[0])}
        />
      </label>
      {file && (
        <p className="rounded-lg bg-slate-50 p-3 text-sm tabular-nums" data-testid="pos-preview">
          {file.lines.length} {file.lines.length === 1 ? 'item' : 'items'} ·{' '}
          {formatMoney(file.totalValue)} taken
          {file.totalDiscount > 0 ? ` · ${formatMoney(file.totalDiscount)} discount` : ''}
          {file.posOutlets.length > 0 ? ` · ${file.posOutlets.join(', ')}` : ''}
        </p>
      )}
      <ErrorBox message={error} />
      <StatusBox message={done} />
      <button className={primaryButton} disabled={!file || pending} data-testid="pos-import">
        {pending ? 'Importing…' : 'Import'}
      </button>
    </form>
  );
}
