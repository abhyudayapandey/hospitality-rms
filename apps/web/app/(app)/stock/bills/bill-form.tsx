'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { addBill } from './actions';
import { BillFiles, type BillFile } from './bill-files';

const OTHER = 'other';
const today = () => new Date().toISOString().slice(0, 10);

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
  amount: startAmount = '',
  done,
}: {
  node: string | null;
  po: string | null;
  /** a bill for an order placed with no supplier named says who sent it */
  askSupplier?: boolean;
  suppliers?: { id: string; name: string }[];
  /** the amount to start from: what was received, for a bill added after receiving */
  amount?: string;
  /** where to go once saved; stays on the page (refreshed) when absent */
  done?: string;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [files, setFiles] = useState<BillFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [supplier, setSupplier] = useState(suppliers[0]?.id ?? OTHER);
  const [name, setName] = useState('');
  const [forWhat, setForWhat] = useState('');
  const [billNo, setBillNo] = useState('');
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState(startAmount);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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
      <BillFiles
        node={node}
        po={po}
        files={files}
        onChange={setFiles}
        onError={setError}
        onBusy={setUploading}
      />
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
