'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { CALENDAR_JOBS, everyWords } from '@outlet-ops/domain';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { archiveJob, archiveLicence, saveJob, type JobInput } from './actions';
import type { Choice } from './licence-form';

/** A form field's text (a file input gives none). */
const field = (f: FormData, name: string) => {
  const v = f.get(name);
  return typeof v === 'string' ? v : '';
};

const EVERY = [1, 2, 3, 4, 6, 12, 24, 36] as const;

/**
 * Adds a regular job or changes one (ADR 069, 073): what it is (the library's jobs suggest
 * names and how often), where, how often, when it is next due, who answers for it (a role at
 * the outlet), who does it (a role at its place; none: the accountable role), and whether
 * each time needs a report or certificate.
 */
export function JobForm({
  places,
  roles,
  ownerRoles,
  existing,
}: {
  places: Choice[];
  roles: Record<string, { code: string; name: string }[]>;
  /** the outlet's roles, for a job at a department (else the place's) */
  ownerRoles?: { code: string; name: string }[];
  existing?: JobInput;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [node, setNode] = useState(existing?.node ?? places[0]?.id ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [every, setEvery] = useState(existing?.every_months ?? 6);
  const [proof, setProof] = useState(existing?.needs_proof ?? true);
  const [key] = useState(() => crypto.randomUUID());
  const here = roles[node] ?? [];
  const owners = ownerRoles ?? here;
  return (
    <form
      aria-label={existing ? 'Change the job' : 'Add a regular job'}
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        start(async () => {
          setError(null);
          const r = await saveJob(
            {
              id: existing?.id ?? null,
              node,
              name,
              every_months: every,
              next_due: field(f, 'next_due'),
              owner_role: field(f, 'owner_role'),
              doer_role: field(f, 'doer_role') || null,
              needs_proof: proof,
            },
            existing ? undefined : key,
          );
          if (!r.ok) {
            setError(r.message);
            return;
          }
          router.push(`/compliance/calendar/${r.data.id}`);
          router.refresh();
        });
      }}
    >
      {places.length > 1 && (
        <label className="block text-sm font-medium">
          Where
          <select value={node} onChange={(e) => setNode(e.target.value)} className={inputClass}>
            {places.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block text-sm font-medium">
        The job
        <input
          required
          list="calendar-jobs"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            const lib = CALENDAR_JOBS.find((j) => j.name === e.target.value);
            if (lib) {
              setEvery(lib.everyMonths);
              setProof(lib.needsProof);
            }
          }}
          className={inputClass}
        />
        <datalist id="calendar-jobs">
          {CALENDAR_JOBS.map((j) => (
            <option key={j.code} value={j.name} />
          ))}
        </datalist>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm font-medium">
          How often
          <select
            value={every}
            onChange={(e) => setEvery(Number(e.target.value))}
            className={inputClass}
          >
            {EVERY.map((m) => (
              <option key={m} value={m}>
                {everyWords(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Next due
          <input
            name="next_due"
            type="date"
            required
            defaultValue={existing?.next_due ?? ''}
            className={inputClass}
          />
        </label>
      </div>
      <label className="block text-sm font-medium">
        Who answers for it
        <select
          name="owner_role"
          required
          defaultValue={existing?.owner_role}
          className={inputClass}
        >
          {owners.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs font-normal text-slate-500">
          They see it on Home and are told when it is due and when it is done.
        </span>
      </label>
      <label className="block text-sm font-medium">
        Who does it
        <select name="doer_role" defaultValue={existing?.doer_role ?? ''} className={inputClass}>
          <option value="">The same person</option>
          {here.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs font-normal text-slate-500">
          Their To do list gets it 14 days before it is due; they can give it to someone there.
        </span>
      </label>
      <label className="flex min-h-12 items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={proof}
          onChange={(e) => setProof(e.target.checked)}
          className="size-5"
        />
        Each time needs a report or certificate
      </label>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        {existing ? 'Save' : 'Add the job'}
      </button>
    </form>
  );
}

/** Removes a licence the outlet no longer needs, or a calendar job, in two taps (kept). */
export function RemoveButton({ kind, id }: { kind: 'licence' | 'job'; id: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const what = kind === 'licence' ? 'licence' : 'job';
  if (!asking) {
    return (
      <button
        type="button"
        disabled={!hydrated}
        onClick={() => setAsking(true)}
        className={secondaryButton}
      >
        Remove this {what}
      </button>
    );
  }
  return (
    <form
      aria-label={`Remove this ${what}?`}
      className="space-y-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-900"
      onSubmit={(e) => {
        e.preventDefault();
        const reason = field(new FormData(e.currentTarget), 'reason');
        start(async () => {
          setError(null);
          const r = kind === 'licence' ? await archiveLicence(id, reason) : await archiveJob(id);
          if (!r.ok) {
            setError(r.message);
            return;
          }
          router.push(kind === 'licence' ? '/compliance' : '/compliance?tab=jobs');
          router.refresh();
        });
      }}
    >
      <p>It is kept with its history; its reminders stop.</p>
      {kind === 'licence' && (
        <label className="block font-medium">
          Why it is no longer needed
          <input name="reason" required maxLength={300} className={inputClass} />
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setAsking(false)} className={secondaryButton}>
          Keep it
        </button>
        <button
          type="submit"
          disabled={pending}
          className="min-h-12 rounded-lg bg-rose-700 font-medium text-white"
        >
          Remove
        </button>
      </div>
      <ErrorBox message={error} />
    </form>
  );
}
