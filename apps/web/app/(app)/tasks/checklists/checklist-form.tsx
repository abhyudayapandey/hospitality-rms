'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
import type { Checklist, JobRole, Person } from '@/lib/tasks';
import { parseSteps, stepsText, type Schedule } from '@/lib/tasks-view';
import { useHydrated } from '@/lib/use-hydrated';
import { archiveChecklist, saveChecklist, type Assign } from '../actions';
import { AssignPicker } from '../assign-picker';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIMES = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);

/** Create or edit a checklist: name, when it runs, who does it, and its steps. */
export function ChecklistForm({
  node,
  people,
  roles,
  existing,
}: {
  node: string;
  people: Person[];
  roles: JobRole[];
  existing: Checklist | null;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const s0 = existing?.schedule;
  const [name, setName] = useState(existing?.name ?? '');
  const [kind, setKind] = useState<Schedule['kind']>(s0?.kind ?? 'daily');
  const [times, setTimes] = useState(
    s0 && s0.kind !== 'every_n_hours' ? s0.times.join(', ') : '09:00',
  );
  const [days, setDays] = useState<number[]>(s0?.kind === 'weekly' ? s0.weekdays : [1]);
  const [every, setEvery] = useState(s0?.kind === 'every_n_hours' ? String(s0.every) : '2');
  const [from, setFrom] = useState(s0?.kind === 'every_n_hours' ? s0.from : '08:00');
  const [to, setTo] = useState(s0?.kind === 'every_n_hours' ? s0.to : '22:00');
  const a0 = existing?.assign;
  const [assign, setAssign] = useState<Assign>(
    a0?.mode === 'job_role'
      ? { mode: 'job_role', role: a0.role ?? '' }
      : a0?.mode === 'person'
        ? { mode: 'person', user_id: a0.user_id ?? '' }
        : a0?.mode === 'on_shift'
          ? { mode: 'on_shift' }
          : { mode: 'job_role', role: roles[0]?.code ?? '' },
  );
  const [steps, setSteps] = useState(existing ? stepsText(existing.steps) : '');
  const [error, setError] = useState<string | null>(null);

  const schedule = (): Schedule =>
    kind === 'daily'
      ? { kind, times: TIMES(times) }
      : kind === 'weekly'
        ? { kind, weekdays: [...days].sort((a, b) => a - b), times: TIMES(times) }
        : { kind, every: Number(every), from, to };

  const save = () =>
    start(async () => {
      setError(null);
      const parsed = parseSteps(steps);
      if (typeof parsed === 'string') return setError(parsed);
      const r = await saveChecklist({
        id: existing?.id ?? null,
        node,
        name,
        schedule: schedule(),
        assign,
        steps: parsed,
      });
      if (!r.ok) return setError(r.message);
      router.push(`/tasks/checklists?node=${node}`);
    });

  const stop = () =>
    start(async () => {
      const r = await archiveChecklist(existing!.id);
      if (!r.ok) return setError(r.message);
      router.push(`/tasks/checklists?node=${node}`);
    });

  return (
    <form
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Runs</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as Schedule['kind'])}
          className={inputClass}
        >
          <option value="daily">Every day</option>
          <option value="weekly">On some days of the week</option>
          <option value="every_n_hours">Every few hours</option>
        </select>
      </label>
      {kind === 'weekly' && (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Days</legend>
          <div className="grid grid-cols-7 gap-1">
            {DAYS.map((d, i) => (
              <label
                key={d}
                className={`flex min-h-11 items-center justify-center rounded-lg text-xs ring-1 ${
                  days.includes(i + 1) ? 'bg-brand-700 text-white ring-brand-700' : 'ring-slate-300'
                }`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={days.includes(i + 1)}
                  onChange={(e) =>
                    setDays(e.target.checked ? [...days, i + 1] : days.filter((x) => x !== i + 1))
                  }
                />
                {d}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {kind === 'every_n_hours' ? (
        <div className="grid grid-cols-3 gap-2">
          <label className="block space-y-1">
            <span className="text-sm font-medium">Every</span>
            <select value={every} onChange={(e) => setEvery(e.target.value)} className={inputClass}>
              {[1, 2, 3, 4, 6, 8, 12].map((h) => (
                <option key={h} value={h}>
                  {h} h
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">From</span>
            <input
              type="time"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">To</span>
            <input
              type="time"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>
      ) : (
        <label className="block space-y-1">
          <span className="text-sm font-medium">At (local times, e.g. 07:00, 15:00)</span>
          <input value={times} onChange={(e) => setTimes(e.target.value)} className={inputClass} />
        </label>
      )}
      <AssignPicker value={assign} onChange={setAssign} people={people} roles={roles} />
      <label className="block space-y-1">
        <span className="text-sm font-medium">Steps (one per line)</span>
        <textarea
          value={steps}
          onChange={(e) => setSteps(e.target.value)}
          placeholder={'Walk-in temperature | 0-5 °C\nFloors swept\nNotes | text'}
          className={`${inputClass} min-h-32 py-2`}
        />
        <span className="block text-xs text-slate-500">
          After a | add a range like 0-5 °C (readings outside it are flagged), or text, photo, or
          photo required.
        </span>
      </label>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        {existing ? 'Save checklist' : 'Create checklist'}
      </button>
      {existing && !existing.archived_at && (
        <button
          type="button"
          onClick={stop}
          disabled={!hydrated || pending}
          className={secondaryButton}
        >
          Stop this checklist
        </button>
      )}
    </form>
  );
}
