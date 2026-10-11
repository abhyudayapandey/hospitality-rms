'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
import { ItemThumb } from '@/components/item-thumb';
import { formatQty } from '@/lib/qty';
import { useHydrated } from '@/lib/use-hydrated';
import { sendByTask } from '../../stock/actions';

export interface SendLine {
  item_id: string;
  name: string;
  base_uom: string;
  asked: string;
  at_store: string;
  sent: string | null;
}

/**
 * Taking stock from the store to whoever asked (ADR 115): what was asked and what the store
 * has; one tap when all of it went, else how many of each. It leaves the store then, and
 * whoever asked gets it to receive.
 */
export function SendTask({
  task,
  lines,
  canWork,
}: {
  task: string;
  lines: SendLine[];
  canWork: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [less, setLess] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>({});
  const send = (all: boolean) =>
    start(async () => {
      setError(null);
      if (!all && lines.some((l) => !(qty[l.item_id] ?? '').trim())) {
        setError('Say how many you took of each (0 if none).');
        return;
      }
      const r = await sendByTask(
        task,
        all ? null : lines.map((l) => ({ item_id: l.item_id, qty: Number(qty[l.item_id]) })),
      );
      if (!r.ok) setError(r.message);
      else router.refresh();
    });
  return (
    <section className="space-y-3" data-testid="send-task">
      <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
        {lines.map((l) => (
          <li key={l.item_id} className="flex items-center justify-between gap-3 px-4 py-2">
            <ItemThumb name={l.name} />
            <label htmlFor={`s-${l.item_id}`} className="min-w-0 flex-1 text-sm">
              <span className="block font-medium">{l.name}</span>
              <span className="text-xs text-slate-500">
                {l.sent !== null
                  ? `sent ${formatQty(l.sent, l.base_uom)}`
                  : `${formatQty(l.asked, l.base_uom)} asked · store has ${formatQty(l.at_store, l.base_uom)}`}
              </span>
            </label>
            {less && (
              <input
                id={`s-${l.item_id}`}
                aria-label={`Took ${l.name}`}
                inputMode="decimal"
                value={qty[l.item_id] ?? ''}
                onChange={(e) => setQty((v) => ({ ...v, [l.item_id]: e.target.value }))}
                className={`${inputClass} max-w-24 text-right`}
              />
            )}
          </li>
        ))}
      </ul>
      <ErrorBox message={error} />
      {canWork &&
        (less ? (
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setLess(false)} className={secondaryButton}>
              Back
            </button>
            <button
              type="button"
              disabled={!hydrated || pending}
              onClick={() => send(false)}
              className={primaryButton}
            >
              Sent these
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <button
              type="button"
              disabled={!hydrated || pending}
              onClick={() => send(true)}
              className={primaryButton}
            >
              I took all of it
            </button>
            <button type="button" onClick={() => setLess(true)} className={secondaryButton}>
              I took less
            </button>
          </div>
        ))}
    </section>
  );
}
