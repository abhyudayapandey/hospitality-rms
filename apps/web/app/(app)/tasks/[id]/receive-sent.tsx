'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
import type { Person } from '@/lib/tasks';
import { useHydrated } from '@/lib/use-hydrated';
import { reassignTask, receiveSent } from '../actions';

export interface SentLine {
  item_id: string;
  name: string;
  base_uom: string;
  sent: string;
  received: string | null;
}

const n = (v: string | null) => (v === null ? null : Number(v));

/**
 * A delivery from the Main Store (ADR 051): what arrived of each item, then Confirm. Nothing is
 * filled in; "Everything arrived" fills what was sent. Less than sent is a shortfall, and the
 * head and the sender are told.
 */
export function ReceiveSent({ task, lines }: { task: string; lines: SentLine[] }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = () =>
    start(async () => {
      setError(null);
      const missing = lines.find((l) => !(qty[l.item_id] ?? '').trim());
      if (missing) {
        setError(`Enter what arrived of ${missing.name} (0 if nothing).`);
        return;
      }
      const r = await receiveSent(
        task,
        lines.map((l) => ({ item_id: l.item_id, qty: Number(qty[l.item_id]) })),
      );
      if (!r.ok) setError(r.message);
      else router.refresh();
    });

  return (
    <form
      className="space-y-4"
      data-testid="receive-sent"
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
          onClick={() => setQty(Object.fromEntries(lines.map((l) => [l.item_id, l.sent])))}
        >
          Everything arrived
        </button>
      </div>
      <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
        {lines.map((l) => (
          <li key={l.item_id} className="flex items-center justify-between gap-3 px-4 py-2">
            <label htmlFor={`r-${l.item_id}`} className="min-w-0 flex-1 text-sm">
              <span className="block font-medium">{l.name}</span>
              <span className="text-xs text-slate-500">
                sent {Number(l.sent)} {l.base_uom}
              </span>
            </label>
            <input
              id={`r-${l.item_id}`}
              aria-label={`Arrived ${l.name}`}
              inputMode="decimal"
              value={qty[l.item_id] ?? ''}
              onChange={(e) => setQty((v) => ({ ...v, [l.item_id]: e.target.value }))}
              className={`${inputClass} max-w-28 text-right`}
            />
          </li>
        ))}
      </ul>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Confirm what arrived
      </button>
    </form>
  );
}

/** What was sent and, once confirmed, what arrived: for everyone else who sees the task. */
export function SentLines({ lines }: { lines: SentLine[] }) {
  return (
    <ul
      className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
      data-testid="sent-lines"
    >
      {lines.map((l) => {
        const got = n(l.received);
        return (
          <li key={l.item_id} className="flex justify-between gap-2 px-4 py-3 text-sm">
            <span className="font-medium">{l.name}</span>
            <span className="text-right tabular-nums">
              sent {Number(l.sent)} {l.base_uom}
              {got !== null && (
                <span
                  className={`block text-xs ${got < Number(l.sent) ? 'text-amber-800' : 'text-slate-500'}`}
                >
                  arrived {got} {l.base_uom}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The head passes the delivery to someone in the team. */
export function ReassignTask({
  task,
  people,
  current,
}: {
  task: string;
  people: Person[];
  current: string | null;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const others = people.filter((p) => p.user_id !== current);
  const [user, setUser] = useState(others[0]?.user_id ?? '');
  const [error, setError] = useState<string | null>(null);
  if (others.length === 0) return null;
  return (
    <form
      className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      data-testid="reassign"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const r = await reassignTask(task, user);
          if (!r.ok) setError(r.message);
          else router.refresh();
        });
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium">Give it to someone</span>
        <select value={user} onChange={(e) => setUser(e.target.value)} className={inputClass}>
          {others.map((p) => (
            <option key={p.user_id} value={p.user_id}>
              {p.name}
              {p.job_role ? ` (${p.job_role})` : ''}
            </option>
          ))}
        </select>
      </label>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={secondaryButton}>
        Assign
      </button>
    </form>
  );
}
