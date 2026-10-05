'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { PHOTO_MAX_SIDE, PHOTO_QUALITY, resizePhoto } from '@/lib/photo-resize';
import { useHydrated } from '@/lib/use-hydrated';
import { addBill, getBillUploadUrl } from './actions';

const OTHER = 'other';
const MAX_FILES = 5;
const today = () => new Date().toISOString().slice(0, 10);

interface Uploaded {
  key: string;
  name: string;
}

/**
 * A vendor bill (ADR 050): its photos or PDFs, number, date and amount. With `po` it is the
 * bill for that order's goods (the supplier is the order's); without, a bill for a service at
 * `node`, with the supplier (from the list or typed) and what it was for. Photos are shrunk on
 * the phone like every other photo; a PDF goes up as it is (10 MB at most).
 */
export function BillForm({
  node,
  po,
  suppliers = [],
  askSupplier = false,
  done,
}: {
  node: string | null;
  po: string | null;
  /** a bill for an order placed with no supplier named says who sent it */
  askSupplier?: boolean;
  suppliers?: { id: string; name: string }[];
  /** where to go once saved; stays on the page (refreshed) when absent */
  done?: string;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [files, setFiles] = useState<Uploaded[]>([]);
  const [uploading, setUploading] = useState(false);
  const [supplier, setSupplier] = useState(suppliers[0]?.id ?? OTHER);
  const [name, setName] = useState('');
  const [forWhat, setForWhat] = useState('');
  const [billNo, setBillNo] = useState('');
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const upload = async (list: FileList) => {
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(list).slice(0, MAX_FILES - files.length)) {
        const pdf = file.type === 'application/pdf';
        const blob = pdf ? file : await resizePhoto(file, PHOTO_MAX_SIDE, PHOTO_QUALITY);
        const type = pdf ? 'application/pdf' : 'image/jpeg';
        const target = await getBillUploadUrl(node, po, type, blob.size);
        if (!target.ok) throw new Error(target.message);
        const form = new FormData();
        for (const [k, v] of Object.entries(target.data.fields)) form.append(k, v);
        form.append('file', blob);
        const res = await fetch(target.data.url, { method: 'POST', body: form });
        if (!res.ok) throw new Error(`${file.name} did not upload. Try again.`);
        setFiles((f) => [...f, { key: target.data.key, name: pdf ? file.name : 'Photo' }]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The file did not upload. Try again.');
    } finally {
      setUploading(false);
    }
  };

  // the supplier is asked for on a service bill, and on a bill for an order placed without one
  const named = !po || askSupplier;

  const submit = () =>
    start(async () => {
      setError(null);
      if (files.length === 0) {
        setError('Add a photo or PDF of the bill.');
        return;
      }
      const value = Number(amount);
      if (!(value > 0)) {
        setError('Enter the amount on the bill.');
        return;
      }
      const r = await addBill(
        {
          node,
          po,
          supplier_id: !named || supplier === OTHER ? null : supplier,
          supplier_name: !named || supplier !== OTHER ? null : name.trim() || null,
          bill_no: billNo.trim() || null,
          bill_date: date,
          amount: value,
          description: po ? null : forWhat.trim() || null,
          files: files.map((f) => f.key),
        },
        key,
      );
      if (!r.ok) {
        setError(r.message);
        return;
      }
      if (done) {
        router.push(done);
        return;
      }
      setSaved(true);
      setFiles([]);
      setBillNo('');
      setAmount('');
      setKey(crypto.randomUUID());
      router.refresh();
    });

  return (
    <form
      data-testid="bill-form"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="space-y-2">
        <span className="text-sm font-medium">Photo or PDF of the bill</span>
        {files.length > 0 && (
          <ul className="space-y-1 text-sm" data-testid="bill-files">
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
                  onClick={() => setFiles((all) => all.filter((x) => x.key !== f.key))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {files.length < MAX_FILES && (
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
              aria-label="Bill photo or PDF"
              disabled={uploading || !hydrated}
              onChange={(e) => {
                if (e.target.files?.length) void upload(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>
      {named && (
        <>
          <label className="block space-y-1">
            <span className="text-sm font-medium">Supplier</span>
            <select
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              className={inputClass}
            >
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              <option value={OTHER}>Someone not on the list</option>
            </select>
          </label>
          {supplier === OTHER && (
            <label className="block space-y-1">
              <span className="text-sm font-medium">Supplier name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                required
                className={inputClass}
              />
            </label>
          )}
        </>
      )}
      {!po && (
        <label className="block space-y-1">
          <span className="text-sm font-medium">What was it for?</span>
          <input
            value={forWhat}
            onChange={(e) => setForWhat(e.target.value)}
            maxLength={300}
            required
            placeholder="e.g. Linen washing, week 40"
            className={inputClass}
          />
        </label>
      )}
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Amount (₹)</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            className={inputClass}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Bill date</span>
          <input
            type="date"
            value={date}
            max={today()}
            onChange={(e) => setDate(e.target.value)}
            required
            className={inputClass}
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Bill number (optional)</span>
        <input
          value={billNo}
          onChange={(e) => setBillNo(e.target.value)}
          maxLength={60}
          className={inputClass}
        />
      </label>
      <ErrorBox message={error} />
      <StatusBox message={saved ? 'Bill saved.' : null} />
      <button type="submit" disabled={!hydrated || pending || uploading} className={primaryButton}>
        Save the bill
      </button>
    </form>
  );
}
