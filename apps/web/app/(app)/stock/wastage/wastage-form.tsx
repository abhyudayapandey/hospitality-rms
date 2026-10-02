'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { formatMoney } from '@/lib/format';
import type { ItemOption } from '@/lib/inventory';
import { PhotoField } from '@/components/photo-field';
import { getWastageUploadUrl, recordWastage } from '../actions';

const REASONS = [
  ['spoiled', 'Spoiled'],
  ['expired', 'Expired'],
  ['prep_error', 'Prep error'],
  ['damaged', 'Damaged'],
  ['other', 'Other'],
] as const;

export function WastageForm({
  node,
  items,
  threshold,
  photos,
  initial,
}: {
  node: string;
  items: ItemOption[];
  threshold: number;
  photos: boolean;
  /** prefilled from a link, e.g. an expired batch on the production page */
  initial?: { item: string; qty: string; reason: string };
}) {
  const router = useRouter();
  const [itemId, setItemId] = useState(
    items.find((i) => i.item_id === initial?.item)?.item_id ?? items[0]?.item_id ?? '',
  );
  const [qty, setQty] = useState(initial?.qty ?? '');
  const [reason, setReason] = useState<string>(
    REASONS.some(([r]) => r === initial?.reason) ? initial!.reason : 'spoiled',
  );
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const item = items.find((i) => i.item_id === itemId);
  const value = useMemo(() => (item && qty ? Number(qty) * Number(item.avg_cost) : 0), [item, qty]);
  const needsApproval = value > threshold;

  const submit = () =>
    start(async () => {
      setError(null);
      setDone(null);
      const n = Number(qty);
      if (!item || !Number.isFinite(n) || n <= 0) {
        setError('Enter how much was wasted.');
        return;
      }
      const r = await recordWastage(
        node,
        [{ item_id: itemId, qty: n, reason, photo_key: photoKey }],
        key,
      );
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setDone(r.data.approval ? 'Sent to the outlet manager for approval.' : 'Wastage recorded.');
      setQty('');
      setPhotoKey(null);
      setKey(crypto.randomUUID());
      router.refresh();
    });

  if (items.length === 0) return <p className="text-slate-600">No items are set up here yet.</p>;
  return (
    <form
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium">Item</span>
        <select value={itemId} onChange={(e) => setItemId(e.target.value)} className={inputClass}>
          {items.map((i) => (
            <option key={i.item_id} value={i.item_id}>
              {i.name} ({i.base_uom})
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Quantity ({item?.base_uom})</span>
          <input
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Reason</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass}>
            {REASONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      {value > 0 && (
        <p className="text-sm text-slate-600">
          Worth about {formatMoney(value)}.{' '}
          {needsApproval
            ? `Over ${formatMoney(threshold)}: needs a photo and the outlet manager's approval.`
            : 'Recorded straight away.'}
        </p>
      )}
      {needsApproval &&
        (photos ? (
          <PhotoField
            node={node}
            photoKey={photoKey}
            onChange={setPhotoKey}
            getUploadUrl={getWastageUploadUrl}
            label="Wastage photo"
          />
        ) : (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            Photo upload isn&apos;t set up here, so this can&apos;t be recorded.
          </p>
        ))}
      <ErrorBox message={error} />
      <StatusBox message={done} />
      <button
        type="submit"
        disabled={!hydrated || pending || (needsApproval && !photoKey)}
        className={primaryButton}
      >
        Record wastage
      </button>
    </form>
  );
}
