'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { ErrorBox, primaryButton, StatusBox } from '@/components/messages';
import { formatMoney } from '@/lib/format';
import type { ItemOption } from '@/lib/inventory';
import { PhotoField } from '@/components/photo-field';
import { ACTION_QUEUE_EVENT, indexedDbActions, type QueuedWastage } from '@/lib/action-queue';
import { askDiscard, getWastageUploadUrl, recordWastage } from '../actions';
import { ItemPicker } from '@/components/item-picker';
import { Stepper } from '@/components/stepper';

const REASONS = [
  ['spoiled', 'Spoiled'],
  ['expired', 'Expired'],
  ['prep_error', 'Prep error'],
  ['damaged', 'Damaged'],
  ['other', 'Other'],
] as const;

/**
 * Wastage (ADR 113): nothing is chosen until the person chooses it. The item from pictures
 * (what is wasted here most first, a search above), how much, why as chips, a photo above the
 * button; the button stays off until the item, the amount and the reason are given. A link
 * (an expired batch) may say all three.
 */
export function WastageForm({
  node,
  items,
  often,
  threshold,
  photos,
  initial,
  userId,
}: {
  node: string;
  userId: string;
  items: ItemOption[];
  /** item ids wasted here lately, first in the grid */
  often: string[];
  threshold: number;
  photos: boolean;
  /** prefilled from a link, e.g. an expired batch on the production page */
  initial?: { item: string; qty: string; reason: string };
}) {
  const router = useRouter();
  const [itemId, setItemId] = useState<string | null>(
    items.find((i) => i.item_id === initial?.item)?.item_id ?? null,
  );
  const [qty, setQty] = useState(initial?.qty ?? '');
  const [reason, setReason] = useState<string | null>(
    REASONS.some(([r]) => r === initial?.reason) ? initial!.reason : null,
  );
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const item = items.find((i) => i.item_id === itemId);
  const value = useMemo(() => (item && qty ? Number(qty) * Number(item.avg_cost) : 0), [item, qty]);
  // thrown away only once the GM approves (ADR 092): asked, not recorded
  const needsGm = !!item?.needs_gm;
  const needsApproval = !needsGm && value > threshold;

  const ask = () =>
    start(async () => {
      setError(null);
      setDone(null);
      const n = Number(qty);
      if (!item || !reason || !Number.isFinite(n) || n <= 0) {
        setError('Enter how much to throw away.');
        return;
      }
      const r = await askDiscard(node, item.item_id, n, reason, key);
      if (!r.ok) return setError(r.message);
      setDone('Asked. Once the GM approves, it goes to someone here to throw away.');
      setQty('');
      setKey(crypto.randomUUID());
      router.refresh();
    });

  const submit = () =>
    start(async () => {
      setError(null);
      setDone(null);
      const n = Number(qty);
      if (!item || !reason || !Number.isFinite(n) || n <= 0) {
        setError('Enter how much was wasted.');
        return;
      }
      const lines = [{ item_id: item.item_id, qty: n, reason, photo_key: photoKey }];
      const clientTs = new Date().toISOString(); // when it happened, kept if it syncs later
      // Small wastage (no photo, no approval) is saved on the phone when there is no signal
      // and sent later with its original time (INV-8).
      const saveOffline = async () => {
        const q: QueuedWastage = {
          kind: 'wastage',
          idempotencyKey: key,
          userId,
          clientTs,
          node,
          lines: lines.map(({ item_id, qty, reason }) => ({ item_id, qty, reason })),
        };
        await indexedDbActions.put(q);
        window.dispatchEvent(new Event(ACTION_QUEUE_EVENT));
        setDone('No connection. Saved on this phone; it will be sent when you are back online.');
        setQty('');
        setKey(crypto.randomUUID());
      };
      if (!needsApproval && !navigator.onLine) return saveOffline();
      let r;
      try {
        r = await recordWastage(node, lines, key);
      } catch {
        if (!needsApproval) return saveOffline(); // the request did not get through
        setError('No connection. A photo and approval need a connection; try again.');
        return;
      }
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
        if (needsGm) ask();
        else submit();
      }}
    >
      <ItemPicker
        items={items}
        value={itemId}
        onChange={(id) => {
          setItemId(id);
          setDone(null);
        }}
        often={often}
        note={(i) => `${i.base_uom}`}
      />
      {item && (
        <div className="space-y-1">
          <span className="text-sm font-medium">How much ({item.base_uom})</span>
          <Stepper value={qty} onChange={setQty} label={`Quantity (${item.base_uom})`} min={0} />
        </div>
      )}
      <div role="group" aria-label="Reason" className="space-y-1">
        <span className="text-sm font-medium">Why</span>
        <div className="flex flex-wrap gap-2">
          {REASONS.map(([v, l]) => (
            <button
              key={v}
              type="button"
              aria-pressed={reason === v}
              onClick={() => setReason(v)}
              className={`min-h-11 rounded-full px-4 text-sm font-medium ring-1 ${
                reason === v
                  ? 'bg-brand-700 text-white ring-brand-700'
                  : 'bg-white text-slate-800 ring-slate-300'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      {needsGm && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="needs-gm">
          {item?.name} is thrown away only once the GM approves. Ask, and the GM gives it to someone
          here to throw away.
        </p>
      )}
      {value > 0 && !needsGm && (
        <p className="text-sm text-slate-600">
          Worth about {formatMoney(value)}.{' '}
          {needsApproval
            ? `Over ${formatMoney(threshold)}: needs a photo and the outlet manager's approval.`
            : 'Recorded straight away.'}
        </p>
      )}
      {/* a photo above the button (ADR 098): asked for over the limit, welcome below it */}
      {!needsGm &&
        (photos ? (
          <PhotoField
            node={node}
            photoKey={photoKey}
            onChange={setPhotoKey}
            getUploadUrl={getWastageUploadUrl}
            label={needsApproval ? 'Wastage photo' : 'Wastage photo (optional)'}
          />
        ) : needsApproval ? (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            Photos can&apos;t be taken here right now. Tell your manager.
          </p>
        ) : null)}
      <ErrorBox message={error} />
      <StatusBox message={done} />
      <button
        type="submit"
        disabled={
          !hydrated ||
          pending ||
          !item ||
          !reason ||
          !(Number(qty) > 0) ||
          (needsApproval && !photoKey)
        }
        className={primaryButton}
      >
        {needsGm ? 'Ask the GM' : 'Record wastage'}
      </button>
    </form>
  );
}
