'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { receivePo } from '../../actions';

export interface ReceiveLine {
  item_id: string;
  name: string;
  base_uom: string;
  ordered: string;
  received: string;
}

const remaining = (l: ReceiveLine) => Math.max(0, Number(l.ordered) - Number(l.received));

export function ReceiveForm({ po, lines }: { po: string; lines: ReceiveLine[] }) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.item_id, String(remaining(l))])),
  );
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = () =>
    start(async () => {
      setError(null);
      const payload = lines
        .map((l) => ({ item_id: l.item_id, qty: Number(qty[l.item_id] || 0) }))
        .filter((l) => l.qty > 0);
      if (payload.length === 0) {
        setError('Enter what arrived.');
        return;
      }
      const r = await receivePo(po, payload, key);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      const over = payload.some((p) => {
        const l = lines.find((x) => x.item_id === p.item_id)!;
        return p.qty > remaining(l) + Number(l.ordered) * 0.05;
      });
      setDone(
        over
          ? 'Received. Anything more than 5% over the order was sent to the outlet manager.'
          : 'Received.',
      );
      setKey(crypto.randomUUID());
      router.refresh();
    });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2 className="text-sm font-semibold text-slate-500">What arrived</h2>
      <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
        {lines.map((l) => (
          <li key={l.item_id} className="flex items-center justify-between gap-3 px-4 py-2">
            <label htmlFor={`r-${l.item_id}`} className="min-w-0 flex-1 text-sm">
              <span className="block font-medium">{l.name}</span>
              <span className="text-xs text-slate-500">
                ordered {Number(l.ordered)} · received {Number(l.received)} {l.base_uom}
              </span>
            </label>
            <input
              id={`r-${l.item_id}`}
              aria-label={`Received ${l.name}`}
              inputMode="decimal"
              value={qty[l.item_id] ?? ''}
              onChange={(e) => setQty((v) => ({ ...v, [l.item_id]: e.target.value }))}
              className={`${inputClass} max-w-28 text-right`}
            />
          </li>
        ))}
      </ul>
      <ErrorBox message={error} />
      <StatusBox message={done} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Receive goods
      </button>
    </form>
  );
}
