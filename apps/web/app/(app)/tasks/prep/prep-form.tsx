'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { localToInstant, localToday } from '@/lib/dates';
import type { JobRole, Person, PrepSuggestion } from '@/lib/tasks';
import { useHydrated } from '@/lib/use-hydrated';
import { createPrepTasks, type Assign } from '../actions';
import { AssignPicker } from '../assign-picker';

const n = (s: string) => Number(Number(s).toFixed(3));
/** '2,000 g': Indian digit grouping, the unit on every figure (UX U-24) */
const q = (s: string, unit: string) => `${n(s).toLocaleString('en-IN')} ${unit}`;

export function PrepForm({
  store,
  tz,
  lines,
  canCreate,
  people,
  roles,
}: {
  store: string;
  tz: string;
  lines: PrepSuggestion[];
  canCreate: boolean;
  people: Person[];
  roles: JobRole[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      lines.map((l) => [l.item_id, n(l.suggested) > 0 ? String(n(l.suggested)) : '']),
    ),
  );
  const [time, setTime] = useState('11:00');
  const [assign, setAssign] = useState<Assign>(
    roles[0] ? { mode: 'job_role', role: roles[0].code } : { mode: 'on_shift' },
  );
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const chosen = lines
    .map((l) => ({ item_id: l.item_id, qty: Number(qty[l.item_id] ?? '') }))
    .filter((l) => Number.isFinite(l.qty) && l.qty > 0);

  const submit = () =>
    start(async () => {
      setError(null);
      setDone(null);
      if (chosen.length === 0) return setError('Enter how much to make of at least one item.');
      const r = await createPrepTasks({
        store,
        lines: chosen,
        due: localToInstant(localToday(tz), time, tz),
        assign,
      });
      if (!r.ok) return setError(r.message);
      setDone(`${r.data.ids.length} prep task${r.data.ids.length === 1 ? '' : 's'} created.`);
      router.refresh();
    });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <ul
        data-testid="prep-lines"
        className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
      >
        {lines.map((l) => (
          <li key={l.item_id} className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="min-w-0 text-sm">
              <span className="block font-medium">{l.name}</span>
              <span className="block text-xs text-slate-500">
                par {q(l.par, l.unit)} · on hand {q(l.on_hand, l.unit)}
                {n(l.event_need) > 0 && ` · events ${q(l.event_need, l.unit)}`}
                {n(l.open_tasks) > 0 && ` · in prep ${q(l.open_tasks, l.unit)}`}
              </span>
            </span>
            {canCreate ? (
              <input
                inputMode="decimal"
                aria-label={`Make ${l.name} (${l.unit})`}
                value={qty[l.item_id] ?? ''}
                onChange={(e) => setQty({ ...qty, [l.item_id]: e.target.value })}
                className={`${inputClass} w-24 text-right`}
              />
            ) : (
              <span className="text-sm tabular-nums">
                {n(l.suggested)} {l.unit}
              </span>
            )}
          </li>
        ))}
      </ul>
      {canCreate && (
        <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200">
          <label className="block space-y-1">
            <span className="text-sm font-medium">Ready by (today)</span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className={inputClass}
            />
          </label>
          <AssignPicker value={assign} onChange={setAssign} people={people} roles={roles} />
          <ErrorBox message={error} />
          <StatusBox message={done} />
          <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
            Create prep tasks ({chosen.length})
          </button>
        </div>
      )}
    </form>
  );
}
