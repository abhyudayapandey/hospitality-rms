'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { formatMoney } from '@/lib/format';
import { receiveGoods } from '../../actions';
import { BillFiles, type BillFile } from '../../bills/bill-files';
import { formatQty } from '@/lib/qty';
import { ItemThumb } from '@/components/item-thumb';
import { Stepper } from '@/components/stepper';

export interface ReceiveLine {
  item_id: string;
  name: string;
  base_uom: string;
  ordered: string;
  received: string;
  /** where it goes by default when a department asked (ADR 080) */
  receive_to?: 'store' | 'department';
  /** the Main Store keeps this item, so it may stay there */
  desk_keeps?: boolean;
}

const left = (l: ReceiveLine) => Math.max(0, Number(l.ordered) - Number(l.received));
const qtyText = (n: number, uom: string) => formatQty(n, uom);

/**
 * Receiving an order (ADR 051): for each item still to come, what arrived and what it cost
 * (the amount on the bill, required for anything received). Nothing is filled in for them;
 * "Everything arrived as ordered" fills the quantities. The bill's photo or PDF can go with it,
 * or be added later (the order then shows "Bill missing").
 */
export function ReceiveForm({
  po,
  lines,
  billHere,
  department = null,
}: {
  po: string;
  lines: ReceiveLine[];
  /** the bill can be attached now (the order names its supplier) */
  billHere: boolean;
  /** the department that asked, when the Main Store ordered for it (ADR 080) */
  department?: string | null;
}) {
  const router = useRouter();
  const open = lines.filter((l) => left(l) > 0);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState<Record<string, string>>({});
  // where each line goes (the item's default, ADR 080) and its expiry, if any
  const [dest, setDest] = useState<Record<string, 'store' | 'department'>>(() =>
    Object.fromEntries(
      lines.map((l) => [
        l.item_id,
        l.desk_keeps === false ? 'department' : (l.receive_to ?? 'store'),
      ]),
    ),
  );
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<BillFile[]>([]);
  const [billNo, setBillNo] = useState('');
  const [uploading, setUploading] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const total = open.reduce((t, l) => t + (Number(amount[l.item_id]) || 0), 0);

  const submit = () =>
    start(async () => {
      setError(null);
      const payload = open
        .map((l) => ({
          item_id: l.item_id,
          name: l.name,
          qty: Number(qty[l.item_id] || 0),
          amount: Number(amount[l.item_id] || 0),
        }))
        .filter((l) => l.qty > 0);
      if (payload.length === 0) {
        setError('Enter what arrived.');
        return;
      }
      const noAmount = payload.find((l) => !(l.amount > 0));
      if (noAmount) {
        setError(`Enter the amount for ${noAmount.name} (what the bill says).`);
        return;
      }
      const r = await receiveGoods(
        po,
        payload.map(({ item_id, qty, amount }) => ({
          item_id,
          qty,
          amount,
          ...(department && { to: dest[item_id] ?? 'store' }),
          ...(expiry[item_id] && { expires_on: expiry[item_id] }),
        })),
        files.length > 0
          ? { files: files.map((f) => f.key), bill_no: billNo.trim() || null }
          : null,
        key,
      );
      if (!r.ok) {
        setError(r.message);
        return;
      }
      const over = payload.some((p) => {
        const l = open.find((x) => x.item_id === p.item_id)!;
        return p.qty > left(l) + Number(l.ordered) * 0.05;
      });
      setDone(
        over
          ? 'Received. Anything more than 5% over the order was sent to the outlet manager.'
          : 'Received.',
      );
      setQty({});
      setAmount({});
      setExpiry({});
      setFiles([]);
      setKey(crypto.randomUUID());
      router.refresh();
    });

  if (open.length === 0) return null;
  return (
    <form
      className="space-y-4"
      data-testid="receive-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-500">What arrived</h2>
        <button
          type="button"
          className="min-h-11 text-sm font-medium text-brand-700 underline"
          onClick={() => setQty(Object.fromEntries(open.map((l) => [l.item_id, String(left(l))])))}
        >
          Everything arrived as ordered
        </button>
      </div>
      <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
        {open.map((l) => {
          const earlier = Number(l.received);
          return (
            <li key={l.item_id} className="space-y-2 px-4 py-3" data-testid="receive-line">
              <p className="flex items-center gap-3 text-sm">
                <ItemThumb name={l.name} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{l.name}</span>
                  <span className="text-xs text-slate-500">
                    {qtyText(Number(l.ordered), l.base_uom)} ordered
                    {earlier > 0 &&
                      ` · ${qtyText(earlier, l.base_uom)} came earlier, ${qtyText(left(l), l.base_uom)} to come`}
                  </span>
                </span>
              </p>
              <div className="space-y-3">
                <div className="space-y-1">
                  <span className="text-xs text-slate-600">Received ({l.base_uom})</span>
                  {/* nothing filled in (ADR 054): − / + from empty, or type it (ADR 098) */}
                  <Stepper
                    value={qty[l.item_id] ?? ''}
                    onChange={(x) => setQty((v) => ({ ...v, [l.item_id]: x }))}
                    label={`Received ${l.name}`}
                    unit={l.base_uom}
                    min={0}
                  />
                </div>
                <label className="block space-y-1">
                  {/* the line's total on the bill, not a price per unit (ADR 053) */}
                  <span className="text-xs text-slate-600">Bill amount, total (₹)</span>
                  <input
                    aria-label={`Amount ${l.name}`}
                    inputMode="decimal"
                    value={amount[l.item_id] ?? ''}
                    onChange={(e) => setAmount((v) => ({ ...v, [l.item_id]: e.target.value }))}
                    className={`${inputClass} text-right`}
                  />
                </label>
              </div>
              {department && (
                <fieldset className="space-y-1" data-testid="receive-dest">
                  <legend className="text-xs text-slate-600">Where it goes</legend>
                  {l.desk_keeps === false ? (
                    <p className="text-sm" data-testid="receive-dest-fixed">
                      Straight to {department} (the Main Store does not keep it)
                    </p>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {(['store', 'department'] as const).map((d) => (
                        <label
                          key={d}
                          className={`flex min-h-11 items-center justify-center rounded-lg px-2 text-center text-sm ring-1 ${
                            dest[l.item_id] === d
                              ? 'bg-brand-700 font-semibold text-white ring-brand-700'
                              : 'ring-slate-300'
                          }`}
                        >
                          <input
                            type="radio"
                            className="sr-only"
                            name={`dest-${l.item_id}`}
                            checked={dest[l.item_id] === d}
                            onChange={() => setDest((v) => ({ ...v, [l.item_id]: d }))}
                          />
                          {d === 'store' ? 'Into the store' : `To ${department}`}
                        </label>
                      ))}
                    </div>
                  )}
                </fieldset>
              )}
              <label className="block space-y-1">
                <span className="text-xs text-slate-600">Expiry date (optional)</span>
                <input
                  type="date"
                  aria-label={`Expiry ${l.name}`}
                  value={expiry[l.item_id] ?? ''}
                  onChange={(e) => setExpiry((v) => ({ ...v, [l.item_id]: e.target.value }))}
                  className={inputClass}
                />
              </label>
              {Number(qty[l.item_id]) > 0 && Number(amount[l.item_id]) > 0 && (
                <p className="text-right text-xs text-slate-500" data-testid="unit-price">
                  = {formatMoney(Number(amount[l.item_id]) / Number(qty[l.item_id]))} per{' '}
                  {l.base_uom}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="flex justify-between text-sm font-medium" data-testid="receive-total">
        <span>Total</span>
        <span className="tabular-nums">{formatMoney(total)}</span>
      </p>
      {billHere && (
        <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200">
          <BillFiles
            node={null}
            po={po}
            files={files}
            onChange={setFiles}
            onError={setError}
            onBusy={setUploading}
            label="Bill photo or PDF (you can add it later)"
          />
          {files.length > 0 && (
            <label className="block space-y-1">
              <span className="text-sm font-medium">Bill number (optional)</span>
              <input
                value={billNo}
                onChange={(e) => setBillNo(e.target.value)}
                maxLength={60}
                className={inputClass}
              />
            </label>
          )}
        </div>
      )}
      <ErrorBox message={error} />
      <StatusBox message={done} />
      <button type="submit" disabled={!hydrated || pending || uploading} className={primaryButton}>
        Receive
      </button>
    </form>
  );
}
