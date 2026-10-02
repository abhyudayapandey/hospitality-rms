'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  ErrorBox,
  inputClass,
  primaryButton,
  secondaryButton,
  StatusBox,
} from '@/components/messages';
import { PhotoField } from '@/components/photo-field';
import { useHydrated } from '@/lib/use-hydrated';
import type { Person, TaskDetail, TaskStep } from '@/lib/tasks';
import { outOfRange } from '@/lib/tasks-view';
import {
  assignExpiry,
  cancelTask,
  completeStep,
  completeTask,
  discardExpired,
  getDiscardUploadUrl,
  getTaskUploadUrl,
  recordTaskBatch,
} from '../actions';

function range(s: TaskStep): string {
  if (s.min === null && s.max === null) return '';
  const unit = s.unit ? ` ${s.unit}` : '';
  if (s.min === null) return `up to ${s.max}${unit}`;
  if (s.max === null) return `at least ${s.min}${unit}`;
  return `${s.min} to ${s.max}${unit}`;
}

/** The steps, each recorded on its own; then the task is marked done. */
export function TaskWork({
  task,
  canWork,
  photos,
}: {
  task: TaskDetail;
  canWork: boolean;
  photos: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const open = task.status === 'open' || task.status === 'in_progress';
  const allDone = task.steps.every((s) => s.done_at);
  const manual = task.kind === 'one_off' || task.kind === 'checklist';

  const finish = () =>
    start(async () => {
      setError(null);
      const r = await completeTask(task.id, note);
      if (!r.ok) setError(r.message);
      else router.refresh();
    });

  return (
    <section className="space-y-3">
      <ol className="space-y-2" data-testid="steps">
        {task.steps.map((s) => (
          <li
            key={s.id}
            data-testid="step"
            className={`space-y-2 rounded-xl p-3 ring-1 ${
              s.flagged ? 'bg-amber-50 ring-amber-300' : 'bg-white ring-slate-200'
            }`}
          >
            <p className="flex items-start justify-between gap-2">
              <span className="font-medium">{s.label}</span>
              {s.done_at && <span className="text-xs text-emerald-700">✓ done</span>}
            </p>
            {s.kind === 'number' && range(s) && (
              <p className="text-xs text-slate-500">Acceptable: {range(s)}</p>
            )}
            {s.done_at ? (
              <StepValue step={s} unit={task.item?.unit} />
            ) : (
              canWork &&
              open && <StepInputs task={task} step={s} photos={photos} disabled={!hydrated} />
            )}
            {!s.done_at && s.kind === 'batch' && s.value_num !== null && (
              <p className="text-sm text-slate-600">
                Made so far: {s.value_num} {task.item?.unit}
              </p>
            )}
          </li>
        ))}
      </ol>
      {canWork && open && manual && allDone && (
        <div className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <label className="block space-y-1">
            <span className="text-sm font-medium">Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
          </label>
          <ErrorBox message={error} />
          <button
            type="button"
            onClick={finish}
            disabled={!hydrated || pending}
            className={primaryButton}
          >
            Mark task done
          </button>
        </div>
      )}
    </section>
  );
}

function StepValue({ step, unit }: { step: TaskStep; unit: string | undefined }) {
  const by = step.done_by_name ? ` · ${step.done_by_name}` : '';
  let v = '';
  if (step.kind === 'number') v = `${step.value_num}${step.unit ? ` ${step.unit}` : ''}`;
  else if (step.kind === 'text') v = step.value_text ?? '';
  else if (step.kind === 'discard') v = `Thrown away: ${step.value_num} ${unit ?? ''}`;
  else if (step.kind === 'batch') v = `Made: ${step.value_num} ${unit ?? ''}`;
  return (
    <p className="text-sm text-slate-700">
      {v}
      {step.photo_key && <span className="text-slate-500"> · photo added</span>}
      <span className="text-slate-500">{by}</span>
      {step.flagged && (
        <span className="block font-semibold text-amber-800">Outside the acceptable range</span>
      )}
    </p>
  );
}

function StepInputs({
  task,
  step,
  photos,
  disabled,
}: {
  task: TaskDetail;
  step: TaskStep;
  photos: boolean;
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [value, setValue] = useState(
    step.kind === 'discard' && step.value_num !== null ? String(step.value_num) : '',
  );
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const needsPhoto = step.kind === 'photo' || step.photo_required;
  const num = Number(value);
  const warn = step.kind === 'number' && value !== '' && outOfRange(num, step.min, step.max);

  const save = () =>
    start(async () => {
      setError(null);
      setStatus(null);
      let r;
      if (step.kind === 'batch') {
        if (!(num > 0)) return setError('Enter how much you made.');
        r = await recordTaskBatch(task.id, num, key);
      } else if (step.kind === 'discard') {
        if (!(num > 0)) return setError('Enter how much you threw away.');
        r = await discardExpired(task.id, num, photoKey);
        if (r.ok) setStatus('Recorded as expired wastage.');
      } else {
        if (step.kind === 'number' && (value === '' || !Number.isFinite(num))) {
          return setError('Enter the reading.');
        }
        if (step.kind === 'text' && !value.trim()) return setError('Write something first.');
        r = await completeStep(task.id, step.id, {
          ...(step.kind === 'tick' && { done: true }),
          ...(step.kind === 'number' && { number: num }),
          ...(step.kind === 'text' && { text: value }),
          photo_key: photoKey,
        });
        if (r.ok && r.data.flagged) setStatus('Outside the range: your lead has been told.');
      }
      if (!r.ok) return setError(r.message);
      router.refresh();
    });

  const photoField = (purpose: 'task' | 'discard') =>
    photos ? (
      <PhotoField
        node={purpose === 'task' ? task.org_node_id : task.delivery_node_id!}
        photoKey={photoKey}
        onChange={setPhotoKey}
        getUploadUrl={purpose === 'task' ? getTaskUploadUrl : getDiscardUploadUrl}
        label={step.label}
      />
    ) : needsPhoto ? (
      <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
        Photo upload isn&apos;t set up here, so this step can&apos;t be recorded.
      </p>
    ) : null;

  return (
    <div className="space-y-2">
      {(step.kind === 'number' || step.kind === 'batch' || step.kind === 'discard') && (
        <label className="block space-y-1">
          <span className="text-sm">
            {step.kind === 'number'
              ? `Reading${step.unit ? ` (${step.unit})` : ''}`
              : `Quantity (${task.item?.unit ?? ''})`}
          </span>
          <input
            inputMode="decimal"
            aria-label={step.label}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className={inputClass}
          />
        </label>
      )}
      {warn && (
        <p className="text-sm font-medium text-amber-800">
          Outside {range(step)}. Saving it tells your lead.
        </p>
      )}
      {step.kind === 'text' && (
        <textarea
          aria-label={step.label}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={`${inputClass} min-h-20 py-2`}
        />
      )}
      {(needsPhoto || step.kind === 'number') && step.kind !== 'discard' && photoField('task')}
      {step.kind === 'discard' && (
        <>
          <p className="text-xs text-slate-600">
            Worth more than the store&apos;s limit, it needs a photo and the outlet manager&apos;s
            approval.
          </p>
          {photoField('discard')}
        </>
      )}
      <ErrorBox message={error} />
      <StatusBox message={status} />
      <button
        type="button"
        onClick={save}
        disabled={disabled || pending || (needsPhoto && !photoKey)}
        className={step.kind === 'tick' && !needsPhoto ? secondaryButton : primaryButton}
      >
        {step.kind === 'tick'
          ? 'Done'
          : step.kind === 'batch'
            ? 'Record the batch'
            : step.kind === 'discard'
              ? 'Record as expired wastage'
              : 'Save'}
      </button>
    </div>
  );
}

/** The lead gives a reported batch to someone to discard, and maybe to remake. */
export function AssignExpiry({ task, people }: { task: string; people: Person[] }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [user, setUser] = useState(people[0]?.user_id ?? '');
  const [hours, setHours] = useState('1');
  const [remake, setRemake] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    start(async () => {
      setError(null);
      const due = new Date(Date.now() + Number(hours) * 3_600_000).toISOString();
      const r = await assignExpiry(task, user, due, remake);
      if (!r.ok) setError(r.message);
      else router.refresh();
    });
  return (
    <section className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200">
      <h2 className="font-semibold">Give it to someone</h2>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Who</span>
        <select value={user} onChange={(e) => setUser(e.target.value)} className={inputClass}>
          {people.map((p) => (
            <option key={p.user_id} value={p.user_id}>
              {p.name}
              {p.job_role ? ` (${p.job_role})` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Within</span>
        <select value={hours} onChange={(e) => setHours(e.target.value)} className={inputClass}>
          {['1', '2', '4', '8'].map((h) => (
            <option key={h} value={h}>
              {h} hour{h === '1' ? '' : 's'}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          checked={remake}
          onChange={(e) => setRemake(e.target.checked)}
          className="size-5"
        />
        <span>Make a new batch too</span>
      </label>
      <ErrorBox message={error} />
      <button
        type="button"
        onClick={submit}
        disabled={!hydrated || pending || !user}
        className={primaryButton}
      >
        {remake ? 'Assign discard and remake' : 'Assign discard'}
      </button>
    </section>
  );
}

export function CancelTask({ task }: { task: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <details className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
      <summary className="min-h-11 cursor-pointer content-center text-sm font-medium">
        Cancel this task
      </summary>
      <div className="space-y-2 pt-2">
        <input
          aria-label="Why"
          placeholder="Why"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={inputClass}
        />
        <ErrorBox message={error} />
        <button
          type="button"
          disabled={!hydrated || pending}
          className={secondaryButton}
          onClick={() =>
            start(async () => {
              const r = await cancelTask(task, reason);
              if (!r.ok) setError(r.message);
              else router.refresh();
            })
          }
        >
          Cancel task
        </button>
      </div>
    </details>
  );
}
