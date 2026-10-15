'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  BREAKAGE_REASON_WORDS,
  BREAKAGE_REASONS,
  BROKEN_BY,
  BROKEN_BY_WORDS,
} from '@outlet-ops/domain';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { ItemPicker } from '@/components/item-picker';
import { PhotoField } from '@/components/photo-field';
import { Stepper } from '@/components/stepper';
import type { BreakageItem, BreakagePlace } from '@/lib/breakage';
import { breakable } from '@/lib/breakable';
import { formatQty } from '@/lib/qty';
import { useHydrated } from '@/lib/use-hydrated';
import { getBreakageUploadUrl, itemsAt, recordBreakage } from './actions';

/**
 * Record a breakage (ADR 093) at a department: from which store, what, how many, why and who
 * broke it. Nothing is filled in but the department's own store. What broke is a tile of the
 * things that can break (ADR 153), never a list of everything.
 */
export function BreakageForm({
  place,
  initialItems,
  photos,
}: {
  place: BreakagePlace;
  initialItems: BreakageItem[];
  /** photos can be taken here (a bucket or a photo folder) */
  photos: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [store, setStore] = useState(place.stores[0]?.id ?? '');
  const [items, setItems] = useState(initialItems);
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [by, setBy] = useState('');
  const [person, setPerson] = useState('');
  const [note, setNote] = useState('');
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const choices = breakable(items);
  const item = choices.find((i) => i.item_id === itemId);

  const changeStore = (id: string) =>
    start(async () => {
      setStore(id);
      setItemId('');
      // a photo is stored at the store it came from: a new store needs a new one
      setPhotoKey(null);
      const r = await itemsAt(id);
      if (r.ok) setItems(r.data);
      else setError(r.message);
    });

  const submit = () =>
    start(async () => {
      setError(null);
      setDone(null);
      const n = Number(qty);
      if (!item) return setError('Choose what broke.');
      if (!Number.isFinite(n) || n <= 0) return setError('Enter how many.');
      if (!reason) return setError('Say how it broke.');
      if (!by) return setError('Say who broke it.');
      const r = await recordBreakage({
        place: place.place_id,
        store,
        item: item.item_id,
        qty: n,
        reason,
        brokenBy: by,
        person: by === 'staff' && person ? person : null,
        note,
        photoKey,
        idempotencyKey: key,
      });
      if (!r.ok) return setError(r.message);
      setDone(`Recorded: ${item.name}, ${formatQty(n, item.unit)}.`);
      setItemId('');
      setQty('');
      setReason('');
      setBy('');
      setPerson('');
      setNote('');
      setPhotoKey(null);
      setKey(crypto.randomUUID());
      router.refresh();
    });

  return (
    <form
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2 className="font-semibold">Record a breakage</h2>
      {place.stores.length > 1 && (
        <label className="block space-y-1">
          <span className="text-sm font-medium">From the store</span>
          <select
            value={store}
            onChange={(e) => changeStore(e.target.value)}
            className={inputClass}
          >
            {place.stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="space-y-1">
        <span className="text-sm font-medium">What broke</span>
        <ItemPicker
          items={choices}
          value={itemId || null}
          onChange={(id) => setItemId(id ?? '')}
          label="What broke"
        />
      </div>
      <div className="space-y-3">
        <div className="space-y-1">
          <span className="text-sm font-medium">How many{item ? ` (${item.unit})` : ''}</span>
          <Stepper
            value={qty}
            onChange={setQty}
            label={`How many${item ? ` (${item.unit})` : ''}`}
            min={0}
          />
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-medium">How it broke</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass}>
            <option value="">Choose…</option>
            {BREAKAGE_REASONS.map((r) => (
              <option key={r} value={r}>
                {BREAKAGE_REASON_WORDS[r]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Who broke it</span>
        <select value={by} onChange={(e) => setBy(e.target.value)} className={inputClass}>
          <option value="">Choose…</option>
          {BROKEN_BY.map((b) => (
            <option key={b} value={b}>
              {BROKEN_BY_WORDS[b]}
            </option>
          ))}
        </select>
      </label>
      {by === 'staff' && place.people.length > 0 && (
        <label className="block space-y-1">
          <span className="text-sm font-medium">Who on the staff (if you know)</span>
          <select value={person} onChange={(e) => setPerson(e.target.value)} className={inputClass}>
            <option value="">Not saying</option>
            {place.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block space-y-1">
        <span className="text-sm font-medium">Note (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
      </label>
      {/* a photo above the button (ADR 098), from the live camera (ADR 127) */}
      {photos && store && (
        <PhotoField
          key={`${store}-${key}`}
          node={store}
          photoKey={photoKey}
          onChange={setPhotoKey}
          getUploadUrl={getBreakageUploadUrl}
          label="Photo of what broke"
        />
      )}
      <ErrorBox message={error} />
      <StatusBox message={done} />
      <button type="submit" disabled={!hydrated || pending || !store} className={primaryButton}>
        Record the breakage
      </button>
    </form>
  );
}
