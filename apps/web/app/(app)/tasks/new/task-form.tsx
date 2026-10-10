'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { localToInstant, localToday } from '@/lib/dates';
import type { JobRole, Person } from '@/lib/tasks';
import { parseSteps } from '@/lib/tasks-view';
import { useHydrated } from '@/lib/use-hydrated';
import { createTask, type Assign } from '../actions';
import { AssignPicker } from '../assign-picker';

export function TaskForm({
  node,
  tz,
  people,
  roles,
}: {
  node: string;
  tz: string;
  people: Person[];
  roles: JobRole[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(() => localToday(tz));
  const [time, setTime] = useState('18:00');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal');
  const [assign, setAssign] = useState<Assign>({
    mode: 'person',
    // someone on shift today first (ADR 113); people are listed that way
    user_id: (people.find((p) => p.on_shift) ?? people[0])?.user_id ?? '',
  });
  const [steps, setSteps] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);

  const submit = () =>
    start(async () => {
      setError(null);
      const parsed = parseSteps(steps);
      if (typeof parsed === 'string') return setError(parsed);
      if (!title.trim()) return setError('Give the task a title.');
      const r = await createTask({
        node,
        title,
        description,
        due: localToInstant(date, time, tz),
        priority,
        assign,
        steps: parsed,
        idempotencyKey: key,
      });
      if (!r.ok) return setError(r.message);
      router.push(`/tasks/${r.data.id}`);
    });

  return (
    <form
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium">Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Details (optional)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={`${inputClass} min-h-20 py-2`}
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Due date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Time</span>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Priority</span>
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as typeof priority)}
          className={inputClass}
        >
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </select>
      </label>
      <AssignPicker value={assign} onChange={setAssign} people={people} roles={roles} />
      <label className="block space-y-1">
        <span className="text-sm font-medium">Steps (optional, one per line)</span>
        <textarea
          value={steps}
          onChange={(e) => setSteps(e.target.value)}
          placeholder={'Empty the shelves\nFridge temperature | 0-5 °C\nAfter photo | photo'}
          className={`${inputClass} min-h-28 py-2`}
        />
        <span className="block text-xs text-slate-500">
          After a | add a range like 0-5 °C, or text, photo, or photo required.
        </span>
      </label>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Create task
      </button>
    </form>
  );
}
