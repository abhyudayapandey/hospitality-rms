'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, useTransition } from 'react';
import {
  coverSentence,
  coverWarnings,
  isErrorCode,
  messageFor,
  type CoverAnswer,
} from '@outlet-ops/domain';
import { ErrorBox, StatusBox, primaryButton } from '@/components/messages';
import { outcomeLines, savedMessage } from '@/lib/cover-words';
import { previewRoleCover, setRoleCover, type CoverPreview } from '../../../actions';

interface Role {
  code: string;
  name: string;
  people: number;
  duties: string[];
}

const ANSWERS: { key: CoverAnswer; label: string }[] = [
  { key: 'have', label: 'We have it' },
  { key: 'covered_by', label: 'Someone else does it' },
  { key: 'not_done', label: "We don't do this" },
];

/** A reason it can't be saved, in words; the cover-specific ones say what to do. */
function reason(code: string): string {
  if (code === 'JOB_ROLE_SCOPE') {
    return "That role's work needs something this outlet doesn't have, such as a Main Store.";
  }
  return isErrorCode(code) ? messageFor(code) : messageFor('UNEXPECTED');
}

/**
 * The three answers for one role at one outlet. Each choice is previewed by the database
 * (the save, rolled back): the plain-words line of what moves, the warnings file 37 gives,
 * whose access changes and which tasks move; then Save.
 */
export function CoverForm({
  outlet,
  outletName,
  role,
  now,
  others,
  back,
}: {
  outlet: string;
  outletName: string;
  role: Role & { dutyNames: string[] };
  now: { answer: CoverAnswer; by: string | null; byName: string | null };
  others: Role[];
  back: string;
}) {
  const router = useRouter();
  const id = useId();
  const [answer, setAnswer] = useState<CoverAnswer>(now.answer);
  const [by, setBy] = useState<string>(now.by ?? '');
  const [preview, setPreview] = useState<CoverPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [checking, check] = useTransition();
  const coverer = others.find((o) => o.code === by) ?? null;
  const ready = answer !== 'covered_by' || coverer !== null;
  const same = answer === now.answer && (answer !== 'covered_by' || by === now.by);

  useEffect(() => {
    setPreview(null);
    if (!ready || same) return;
    let live = true;
    check(async () => {
      const r = await previewRoleCover(
        outlet,
        role.code,
        answer,
        answer === 'covered_by' ? by : null,
      );
      if (!live) return;
      if (r.ok) setPreview(r.data);
      else setError(r.message);
    });
    return () => {
      live = false;
    };
  }, [answer, by, ready, same, outlet, role.code]);

  const warnings = ready
    ? coverWarnings({
        outlet: outletName,
        role: role.name,
        answer,
        by: coverer?.name ?? null,
        holders: role.people,
        coverers: coverer?.people ?? 0,
        roleDuties: role.duties,
        byDuties: coverer?.duties ?? [],
      })
    : [];
  const errors = preview?.errors ?? [];
  const save = () =>
    start(async () => {
      setError(null);
      const r = await setRoleCover({
        outlet,
        role: role.code,
        answer,
        by: answer === 'covered_by' ? by : null,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setSaved(savedMessage(r.data));
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="mb-1 font-medium">Who does the {role.name}&apos;s work here?</legend>
        {ANSWERS.map((a) => (
          <label
            key={a.key}
            className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl bg-white px-3 ring-1 ${
              answer === a.key ? 'ring-2 ring-brand-700' : 'ring-slate-200'
            }`}
          >
            <input
              type="radio"
              name={`${id}-answer`}
              value={a.key}
              checked={answer === a.key}
              onChange={() => {
                setAnswer(a.key);
                setSaved(null);
                setError(null);
              }}
              className="h-5 w-5"
            />
            <span>{a.label}</span>
          </label>
        ))}
      </fieldset>
      {answer === 'covered_by' && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Which role does it?</span>
          <select
            value={by}
            onChange={(e) => {
              setBy(e.target.value);
              setSaved(null);
              setError(null);
            }}
            className="min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3"
            aria-label="Which role does it"
          >
            <option value="">Choose a role</option>
            {others.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name} (
                {o.people === 0
                  ? 'nobody here yet'
                  : o.people === 1
                    ? '1 person'
                    : `${o.people} people`}
                )
              </option>
            ))}
          </select>
        </label>
      )}
      {ready && !same && (
        <section
          className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-slate-200"
          data-testid="cover-preview"
        >
          <p data-testid="cover-sentence">
            {coverSentence({
              role: role.name,
              answer,
              by: coverer?.name ?? null,
              wasBy: now.answer === 'covered_by' ? now.byName : null,
              duties: role.dutyNames,
            })}
          </p>
          {warnings.map((w) => (
            <p
              key={w}
              role="note"
              data-testid="cover-warning"
              className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900 ring-1 ring-amber-200"
            >
              {w.charAt(0).toUpperCase() + w.slice(1)}.
            </p>
          ))}
          {checking && <p className="text-sm text-slate-500">Checking what changes…</p>}
          {errors.map((e) => (
            <p
              key={e.code}
              role="alert"
              data-testid="cover-error"
              className="rounded-lg bg-rose-50 p-2 text-sm text-rose-800"
            >
              {reason(e.code)}
            </p>
          ))}
          {preview?.result && (
            <ul className="space-y-1 text-sm text-slate-700" data-testid="cover-outcome">
              {outcomeLines(preview.result, {
                answer,
                role: role.name,
                by: coverer?.name ?? null,
              }).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
        </section>
      )}
      <ErrorBox message={error} />
      <StatusBox message={saved} />
      {saved ? (
        <a href={back} className="block text-center text-sm font-medium text-brand-700 underline">
          Back to who does what
        </a>
      ) : (
        <button
          type="button"
          onClick={save}
          disabled={pending || checking || same || !ready || errors.length > 0 || !preview}
          className={primaryButton}
        >
          Save
        </button>
      )}
    </div>
  );
}
