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
import { stepIcon } from '@outlet-ops/domain';
import { Icon } from '@/components/icon';
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
  sendBack,
  signOff,
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

  // one step at a time for whoever does the task (UX-6): what is done, then the step
  // to do now; the rest wait. Anyone else sees every step.
  const focus = canWork && open && task.steps.length > 1;
  const current = focus ? task.steps.find((s) => !s.done_at) : undefined;
  const doneCount = task.steps.filter((s) => s.done_at).length;
  const shown = focus ? task.steps.filter((s) => s.done_at || s.id === current?.id) : task.steps;
  const later = focus ? task.steps.filter((s) => !s.done_at && s.id !== current?.id) : [];

  return (
    <section className="space-y-3">
      {focus && (
        <div className="space-y-1" data-testid="step-progress">
          <p className="text-sm font-medium text-slate-600">
            {current
              ? `Step ${task.steps.indexOf(current) + 1} of ${task.steps.length}`
              : `All ${task.steps.length} steps done`}
          </p>
          <div className="h-2 overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-brand-700"
              style={{ width: `${(100 * doneCount) / task.steps.length}%` }}
            />
          </div>
        </div>
      )}
      <ol className="space-y-2" data-testid="steps">
        {shown.map((s) => (
          <li
            key={s.id}
            data-testid="step"
            className={`space-y-2 rounded-xl p-3 ring-1 ${
              s.flagged
                ? 'bg-amber-50 ring-amber-300'
                : focus && s.id === current?.id
                  ? 'bg-white ring-2 ring-brand-700'
                  : 'bg-white ring-slate-200'
            }`}
          >
            <p className="flex items-start justify-between gap-2">
              <span
                className={`flex items-center gap-2 font-medium ${focus && s.id === current?.id ? 'text-lg' : ''}`}
              >
                <span
                  data-testid="step-icon"
                  data-icon={stepIcon(s.label, s.kind, s.icon)}
                  className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700"
                >
                  <Icon name={stepIcon(s.label, s.kind, s.icon)} className="size-7" />
                </span>
                {s.label}
              </span>
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
      {later.length > 0 && (
        <p className="text-sm text-slate-500" data-testid="steps-later">
          Then {later.length} more: {later.map((s) => s.label).join(', ')}
        </p>
      )}
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
      {step.checked_by_name && (
        <span className="block text-emerald-700" data-testid="step-checked">
          ✓ checked by {step.checked_by_name}
        </span>
      )}
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
        label={needsPhoto ? step.label : `${step.label}: a photo (optional)`}
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
      {/* any step may take a photo (ADR 079); some need one */}
      {step.kind !== 'discard' && step.kind !== 'batch' && photoField('task')}
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

/**
 * A finished checklist round to sign off (ADR 087): its signer signs it off, or sends it back
 * with what to redo. Whoever did any of it can't (the database says so).
 */
export function SignOffWork({ task }: { task: TaskDetail }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<{ ok: true } | { ok: false; message: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.message);
      else router.refresh();
    });
  return (
    <section className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200">
      <ErrorBox message={error} />
      <button
        type="button"
        disabled={!hydrated || pending}
        className={primaryButton}
        onClick={() => act(() => signOff(task.id))}
      >
        Sign it off
      </button>
      <details className="space-y-2">
        <summary className="min-h-11 cursor-pointer content-center text-sm font-medium">
          Send it back
        </summary>
        <label className="block space-y-1 pt-2">
          <span className="text-sm font-medium">What to redo</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={`${inputClass} min-h-20 py-2`}
          />
        </label>
        <button
          type="button"
          disabled={!hydrated || pending || !note.trim()}
          className={secondaryButton}
          onClick={() => act(() => sendBack(task.id, note))}
        >
          Send back
        </button>
      </details>
    </section>
  );
}
