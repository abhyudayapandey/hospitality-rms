'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { PhotoField } from '@/components/photo-field';
import {
  ACTION_QUEUE_EVENT,
  indexedDbActions,
  pending as queued,
  waitingLines,
  type QueuedCheckLine,
} from '@/lib/action-queue';
import { deviceId } from '@/lib/device';
import { formatQty } from '@/lib/inventory';
import {
  finishStockCheck,
  getCheckUploadUrl,
  recordCheckLine,
  reviewStockCheck,
  type ReviewLine,
} from '../actions';

export interface SheetLine {
  item_id: string;
  name: string;
  unit: string;
  shelf: string | null;
  area: string | null;
  counted_qty: string | null;
  full_units: string | null;
  tenths: number | null;
  pack_unit: string | null;
  pack_size: string | null;
  photo_key: string | null;
}

interface Entry {
  counted: string; // standard mode: the quantity
  full: string; // bar mode: whole bottles
  tenths: string; // bar mode: tenths of the open one, 0 to 9
}

const emptyEntry: Entry = { counted: '', full: '', tenths: '0' };

function entryOf(l: SheetLine, bar: boolean): Entry {
  if (l.counted_qty === null) return emptyEntry;
  return bar
    ? {
        counted: '',
        full: l.full_units ?? String(Math.floor(Number(l.counted_qty))),
        tenths: String(l.tenths ?? 0),
      }
    : { counted: String(Number(l.counted_qty)), full: '', tenths: '0' };
}

/**
 * The blind count sheet (INV-10), then the differences with a photo each, then finish.
 * Counts are saved one item at a time, so several phones can count different areas of one
 * check (INV-7). With no signal a count is saved on the phone with the time it was counted
 * and synced later (INV-8, <ActionSync>); the server keeps the latest original time.
 */
export function CheckSheet({
  checkId,
  node,
  mode,
  status,
  lines,
  userId,
  photos,
  back,
}: {
  checkId: string;
  node: string;
  mode: 'standard' | 'bar';
  status: 'open' | 'review';
  lines: SheetLine[];
  userId: string;
  photos: boolean;
  back: string;
}) {
  const router = useRouter();
  const bar = mode === 'bar';
  const [entries, setEntries] = useState<Record<string, Entry>>(() =>
    Object.fromEntries(lines.map((l) => [l.item_id, entryOf(l, bar)])),
  );
  const [saved, setSaved] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(lines.map((l) => [l.item_id, l.counted_qty !== null])),
  );
  const [area, setArea] = useState('');
  const [waiting, setWaiting] = useState<Map<string, QueuedCheckLine>>(new Map());
  const [review, setReview] = useState<ReviewLine[] | null>(null);
  const [photoKeys, setPhotoKeys] = useState<Record<string, string | null>>({});
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!('indexedDB' in window)) return;
    queued(indexedDbActions, userId)
      .then((a) => setWaiting(waitingLines(a, checkId)))
      .catch(() => setWaiting(new Map()));
  }, [userId, checkId]);
  useEffect(() => {
    reload();
    window.addEventListener(ACTION_QUEUE_EVENT, reload);
    return () => window.removeEventListener(ACTION_QUEUE_EVENT, reload);
  }, [reload]);

  const showDifferences = useCallback(async () => {
    setError(null);
    const r = await reviewStockCheck(checkId);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setReview(r.data);
    setPhotoKeys(Object.fromEntries(r.data.map((l) => [l.item_id, l.photo_key])));
  }, [checkId]);
  useEffect(() => {
    // a check already in review (reopened, or another phone asked): show its differences
    if (status === 'review') void showDifferences();
  }, [status, showDifferences]);

  const quantityOf = (e: Entry): number | null => {
    if (bar) {
      if (e.full.trim() === '') return null;
      const full = Number(e.full);
      const tenths = Number(e.tenths);
      return Number.isFinite(full) && full >= 0 ? full + tenths / 10 : NaN;
    }
    if (e.counted.trim() === '') return null;
    const n = Number(e.counted);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  };

  const save = async (l: SheetLine) => {
    const e = entries[l.item_id] ?? emptyEntry;
    const counted = quantityOf(e);
    if (counted === null) return;
    if (Number.isNaN(counted)) {
      setError(`Check the count for ${l.name}: zero or more.`);
      return;
    }
    setError(null);
    const q: QueuedCheckLine = {
      kind: 'check_line',
      idempotencyKey: crypto.randomUUID(),
      userId,
      clientTs: new Date().toISOString(), // when it was counted
      check: checkId,
      item: l.item_id,
      counted: bar ? null : counted,
      full: bar ? Number(e.full) : null,
      tenths: bar ? Number(e.tenths) : null,
      area: area.trim() || null,
      device: deviceId(),
      photoKey: null,
    };
    const saveOffline = async () => {
      await indexedDbActions.put(q);
      window.dispatchEvent(new Event(ACTION_QUEUE_EVENT));
      setSaved((s) => ({ ...s, [l.item_id]: true }));
    };
    if (!navigator.onLine) return saveOffline();
    try {
      const r = await recordCheckLine({
        check: q.check,
        item: q.item,
        counted: q.counted,
        full: q.full,
        tenths: q.tenths,
        area: q.area,
        device: q.device,
        countedAt: q.clientTs,
      });
      if (!r.ok) {
        if (r.code === 'UNEXPECTED') return saveOffline();
        setError(r.message);
        return;
      }
      setSaved((s) => ({ ...s, [l.item_id]: true }));
    } catch {
      return saveOffline(); // the request did not get through
    }
  };

  const countedNow = lines.filter(
    (l) => saved[l.item_id] || quantityOf(entries[l.item_id] ?? emptyEntry) !== null,
  );

  if (review) {
    const differing = review.filter((l) => l.needs_photo);
    const missing = differing.filter((l) => !photoKeys[l.item_id]);
    return (
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          The counts are locked. Where the count is different from what should be there, add a photo
          as proof, then finish. Differences change stock straight away.
        </p>
        {differing.length === 0 ? (
          <p
            role="status"
            className="rounded-lg bg-emerald-50 p-3 text-sm font-medium text-emerald-800"
          >
            Everything counted matches.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            {differing.map((l) => (
              <li key={l.item_id} className="space-y-2 px-4 py-3" data-testid="difference">
                <div className="flex justify-between gap-2">
                  <span className="font-medium">{l.name}</span>
                  <span className="text-right text-sm tabular-nums">
                    {formatQty(l.counted_qty ?? 0, l.unit)} counted ·{' '}
                    {formatQty(l.expected_qty, l.unit)} expected (
                    {Number(l.difference) > 0 ? '+' : ''}
                    {formatQty(l.difference, l.unit)})
                  </span>
                </div>
                {photos ? (
                  <PhotoField
                    node={node}
                    photoKey={photoKeys[l.item_id] ?? null}
                    onChange={(key) => {
                      setPhotoKeys((p) => ({ ...p, [l.item_id]: key }));
                      if (key) {
                        void recordCheckLine({
                          check: checkId,
                          item: l.item_id,
                          counted: null,
                          photoKey: key,
                        });
                      }
                    }}
                    getUploadUrl={getCheckUploadUrl}
                    label="Photo as proof"
                  />
                ) : (
                  <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                    Photo upload isn&apos;t set up here, so this can&apos;t be finished.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        <ErrorBox message={error} />
        <button
          type="button"
          disabled={pending || missing.length > 0}
          className={primaryButton}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await finishStockCheck(checkId);
              if (!r.ok) {
                setError(r.message);
                return;
              }
              setNotice(
                `Finished: ${r.data.matched} matched, ${r.data.adjusted} changed, ${r.data.not_counted} not counted.`,
              );
              setTimeout(() => router.push(back), 1500);
            })
          }
        >
          Finish stock check
        </button>
        <StatusBox message={notice} />
      </div>
    );
  }

  let lastShelf: string | null | undefined;
  return (
    <div className="space-y-4">
      <label className="block space-y-1">
        <span className="text-sm font-medium">Area you are counting (optional)</span>
        <input
          value={area}
          maxLength={60}
          onChange={(e) => setArea(e.target.value)}
          placeholder="e.g. Back bar, Cold room"
          className={inputClass}
        />
        <span className="text-xs text-slate-500">
          Several phones can count different areas of the same check.
        </span>
      </label>
      {waiting.size > 0 && (
        <p
          data-testid="check-waiting"
          className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
        >
          {waiting.size} count{waiting.size === 1 ? '' : 's'} saved on this phone, waiting for a
          connection.
        </p>
      )}
      <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
        {lines.map((l) => {
          const e = entries[l.item_id] ?? emptyEntry;
          const heading = l.shelf !== lastShelf ? l.shelf : undefined;
          lastShelf = l.shelf;
          const set = (patch: Partial<Entry>) =>
            setEntries((x) => ({ ...x, [l.item_id]: { ...e, ...patch } }));
          return (
            <li key={l.item_id}>
              {heading && (
                <p className="bg-slate-50 px-4 py-1 text-xs font-semibold text-slate-500">
                  {heading}
                </p>
              )}
              <div className="flex items-center justify-between gap-3 px-4 py-2">
                <label htmlFor={`c-${l.item_id}`} className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{l.name}</span>
                  <span className="text-xs text-slate-500">
                    {l.unit}
                    {saved[l.item_id] ? ' · saved' : ''}
                  </span>
                </label>
                {bar ? (
                  <div className="flex items-center gap-2">
                    <input
                      id={`c-${l.item_id}`}
                      aria-label={`Full ${l.name}`}
                      inputMode="numeric"
                      value={e.full}
                      onChange={(ev) => set({ full: ev.target.value })}
                      onBlur={() => void save(l)}
                      className={`${inputClass} max-w-16 text-right`}
                    />
                    <span className="text-xs text-slate-500">+</span>
                    <select
                      aria-label={`Tenths of the open bottle of ${l.name}`}
                      value={e.tenths}
                      onChange={(ev) => {
                        set({ tenths: ev.target.value });
                      }}
                      onBlur={() => void save(l)}
                      className={`${inputClass} max-w-20`}
                    >
                      {Array.from({ length: 10 }, (_, n) => (
                        <option key={n} value={n}>
                          {n}/10
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <input
                    id={`c-${l.item_id}`}
                    aria-label={`Counted ${l.name}`}
                    inputMode="decimal"
                    value={e.counted}
                    onChange={(ev) => set({ counted: ev.target.value })}
                    onBlur={() => void save(l)}
                    className={`${inputClass} max-w-28 text-right`}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <ErrorBox message={error} />
      <button
        type="button"
        disabled={pending || countedNow.length === 0 || waiting.size > 0}
        className={primaryButton}
        onClick={() => start(showDifferences)}
      >
        Show the differences ({countedNow.length} of {lines.length} counted)
      </button>
      {waiting.size > 0 && (
        <p className="text-xs text-slate-500">
          Counts saved on this phone are sent first, when you are back online.
        </p>
      )}
    </div>
  );
}
