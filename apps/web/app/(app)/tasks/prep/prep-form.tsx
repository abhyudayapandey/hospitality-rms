'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ItemThumb } from '@/components/item-thumb';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { formatDay, localToInstant } from '@/lib/dates';
import type { JobRole, Person, PrepSuggestion } from '@/lib/tasks';
import { useHydrated } from '@/lib/use-hydrated';
import { createPrepTasks, type Assign } from '../actions';
import { AssignPicker } from '../assign-picker';

const n = (s: string) => Number(Number(s).toFixed(2));
/** '2,000 g': Indian digit grouping, the unit on every figure (UX U-24) */
const q = (s: string, unit: string) => `${n(s).toLocaleString('en-IN')} ${unit}`;

// When it should be ready (ADR 112): today or tomorrow, from the day to plan; a few usual times.
const TIMES = ['07:00', '10:00', '12:00', '16:00'];

export function PrepForm({
  store,
  tz,
  plan,
  lines,
  canCreate,
  people,
  roles,
}: {
  store: string;
  tz: string;
  /** today and the day to plan: tomorrow from the evening (ADR 112) */
  plan: { today: string; day: string; tomorrow: string };
  lines: PrepSuggestion[];
  canCreate: boolean;
  people: Person[];
  roles: JobRole[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  // nothing is filled in or ticked (ADR 053, 112): "Fill all" sets what is short
  const [qty, setQty] = useState<Record<string, string>>({});
  const [on, setOn] = useState<Record<string, boolean>>({});
  const short = lines.filter((l) => n(l.suggested) > 0);
  const [day, setDay] = useState(plan.day);
  const [time, setTime] = useState(plan.day === plan.today ? '12:00' : '10:00');
  const [assign, setAssign] = useState<Assign>(
    roles[0] ? { mode: 'job_role', role: roles[0].code } : { mode: 'on_shift' },
  );
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const chosen = lines
    .filter((l) => on[l.item_id])
    .map((l) => ({ item_id: l.item_id, qty: Number(qty[l.item_id] ?? '') }))
    .filter((l) => Number.isFinite(l.qty) && l.qty > 0);

  const submit = () =>
    start(async () => {
      setError(null);
      setDone(null);
      if (chosen.length === 0) return setError('Tick at least one item and say how much to make.');
      const r = await createPrepTasks({
        store,
        lines: chosen,
        due: localToInstant(day, time, tz),
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
      {canCreate && short.length > 0 && (
        <button
          type="button"
          data-testid="prep-fill"
          onClick={() => {
            setOn(Object.fromEntries(short.map((l) => [l.item_id, true])));
            setQty(Object.fromEntries(short.map((l) => [l.item_id, String(n(l.suggested))])));
          }}
          className="min-h-12 w-full rounded-xl font-semibold text-brand-700 ring-1 ring-slate-300"
        >
          Fill all {short.length} short {short.length === 1 ? 'item' : 'items'} up to par
        </button>
      )}
      <ul data-testid="prep-lines" className="space-y-2">
        {lines.map((l) => {
          const ticked = Boolean(on[l.item_id]);
          return (
            <li
              key={l.item_id}
              data-testid="prep-line"
              className={`space-y-2 rounded-xl bg-white p-3 ring-1 ${
                ticked ? 'ring-brand-600' : 'ring-slate-200'
              }`}
            >
              {/* the name gets the width; what the store has, then how much to make, below */}
              <label className="flex items-center gap-3">
                {canCreate && (
                  <input
                    type="checkbox"
                    aria-label={`Make ${l.name}`}
                    checked={ticked}
                    onChange={(e) => setOn({ ...on, [l.item_id]: e.target.checked })}
                    className="size-6 shrink-0 accent-brand-700"
                  />
                )}
                <ItemThumb name={l.name} fallback="gravy" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{l.name}</span>
                  <span className="block text-xs text-slate-500">
                    {n(l.suggested) > 0 && (
                      <span className="font-semibold text-amber-800">
                        short {q(l.suggested, l.unit)} ·{' '}
                      </span>
                    )}
                    par {q(l.par, l.unit)} · on hand {q(l.on_hand, l.unit)}
                    {n(l.event_need) > 0 && ` · events ${q(l.event_need, l.unit)}`}
                    {n(l.open_tasks) > 0 && ` · in prep ${q(l.open_tasks, l.unit)}`}
                  </span>
                </span>
              </label>
              {canCreate ? (
                <span className="flex items-center justify-end gap-2">
                  <span className="text-sm text-slate-600">Make</span>
                  <input
                    inputMode="decimal"
                    aria-label={`Make ${l.name} (${l.unit})`}
                    value={qty[l.item_id] ?? ''}
                    disabled={!ticked}
                    onChange={(e) => setQty({ ...qty, [l.item_id]: e.target.value })}
                    className="min-h-12 w-28 shrink-0 rounded-lg border border-slate-300 bg-white px-3 text-right text-base tabular-nums disabled:opacity-50"
                  />
                  <span className="w-8 text-sm text-slate-600">{l.unit}</span>
                </span>
              ) : (
                <p className="text-right text-sm tabular-nums">
                  Make {n(l.suggested)} {l.unit}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {canCreate && (
        <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200">
          <div className="space-y-2">
            <span className="text-sm font-medium">Ready by</span>
            <div role="group" aria-label="Ready on" className="flex gap-2">
              {[
                [plan.today, 'Today'],
                [plan.tomorrow, 'Tomorrow'],
              ].map(([d, w]) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={day === d}
                  onClick={() => setDay(d!)}
                  className={`min-h-11 rounded-full px-4 text-sm ring-1 ${
                    day === d
                      ? 'bg-brand-700 font-semibold text-white ring-brand-700'
                      : 'bg-white ring-slate-300'
                  }`}
                >
                  {w}, {formatDay(d!)}
                </button>
              ))}
            </div>
            <div role="group" aria-label="Ready at" className="flex flex-wrap items-center gap-2">
              {TIMES.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={time === t}
                  onClick={() => setTime(t)}
                  className={`min-h-11 rounded-full px-3 text-sm tabular-nums ring-1 ${
                    time === t
                      ? 'bg-brand-700 font-semibold text-white ring-brand-700'
                      : 'bg-white ring-slate-300'
                  }`}
                >
                  {t}
                </button>
              ))}
              <input
                type="time"
                aria-label="Ready by"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className={`${inputClass} w-32`}
              />
            </div>
          </div>
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
