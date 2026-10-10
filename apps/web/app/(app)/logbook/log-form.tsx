'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import type { LogbookTargets } from '@/lib/logbook';
import { useHydrated } from '@/lib/use-hydrated';
import { writeLog, type HandoverTo } from './actions';

/**
 * Write in the logbook (ADR 089): a handover, for the next shift somewhere at the outlet, a job
 * role there or one person, who acknowledges it; or a log that holds for a while.
 */
export function LogForm({ place, targets }: { place: string; targets: LogbookTargets }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [kind, setKind] = useState<'handover' | 'log'>('handover');
  const [body, setBody] = useState('');
  const [toPlace, setToPlace] = useState(place);
  const [who, setWho] = useState('shift');
  const [hours, setHours] = useState('8');
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const here = targets.people.filter((p) => p.place_id === toPlace);
  const roles = [...new Map(here.map((p) => [p.role, p.role_name ?? p.role])).entries()];

  const to = (): HandoverTo =>
    who === 'shift'
      ? { mode: 'on_shift' }
      : who.startsWith('role:')
        ? { mode: 'job_role', role: who.slice(5) }
        : { mode: 'person', user_id: who.slice(7) };

  const save = () =>
    start(async () => {
      setError(null);
      const r = await writeLog({
        place,
        kind,
        body,
        toPlace: kind === 'handover' ? toPlace : null,
        to: kind === 'handover' ? to() : null,
        validTill:
          kind === 'log' ? new Date(Date.now() + Number(hours) * 3_600_000).toISOString() : null,
        idempotencyKey: key,
      });
      if (!r.ok) return setError(r.message);
      setBody('');
      setKey(crypto.randomUUID());
      router.refresh();
    });

  return (
    <form
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="sr-only">What</legend>
        {(
          [
            ['handover', 'Handover'],
            ['log', 'Log'],
          ] as const
        ).map(([k, label]) => (
          <label
            key={k}
            className={`flex min-h-11 items-center justify-center rounded-lg text-sm font-medium ring-1 ${
              kind === k ? 'bg-brand-700 text-white ring-brand-700' : 'ring-slate-300'
            }`}
          >
            <input
              type="radio"
              name="kind"
              className="sr-only"
              checked={kind === k}
              onChange={() => setKind(k)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <label className="block space-y-1">
        <span className="text-sm font-medium">
          {kind === 'handover' ? 'What they need to know' : 'The log'}
        </span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={2000}
          className={`${inputClass} min-h-24 py-2`}
        />
      </label>
      {kind === 'handover' ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className="text-sm font-medium">Where</span>
            <select
              value={toPlace}
              onChange={(e) => {
                setToPlace(e.target.value);
                setWho('shift');
              }}
              className={inputClass}
            >
              {targets.places.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">For</span>
            <select value={who} onChange={(e) => setWho(e.target.value)} className={inputClass}>
              <option value="shift">The next shift</option>
              {roles.map(([code, name]) => (
                <option key={code} value={`role:${code}`}>
                  Any {name}
                </option>
              ))}
              {here.map((p) => (
                <option key={p.id} value={`person:${p.id}`}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <label className="block space-y-1">
          <span className="text-sm font-medium">Holds for</span>
          <select value={hours} onChange={(e) => setHours(e.target.value)} className={inputClass}>
            {['4', '8', '24', '72', '168'].map((h) => (
              <option key={h} value={h}>
                {Number(h) < 24
                  ? `${h} hours`
                  : Number(h) === 168
                    ? 'a week'
                    : `${Number(h) / 24} day${h === '24' ? '' : 's'}`}
              </option>
            ))}
          </select>
        </label>
      )}
      <ErrorBox message={error} />
      <button
        type="submit"
        disabled={!hydrated || pending || !body.trim()}
        className={primaryButton}
      >
        {kind === 'handover' ? 'Hand over' : 'Save the log'}
      </button>
    </form>
  );
}
