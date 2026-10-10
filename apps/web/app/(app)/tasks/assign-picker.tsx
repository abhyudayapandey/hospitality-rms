'use client';

import { inputClass } from '@/components/messages';
import type { JobRole, Person } from '@/lib/tasks';
import type { Assign } from './actions';

/** Who a task or checklist goes to: a person, a job role there, or whoever is on shift. */
export function AssignPicker({
  value,
  onChange,
  people,
  roles,
}: {
  value: Assign;
  onChange: (a: Assign) => void;
  people: Person[];
  roles: JobRole[];
}) {
  // marked where the page asked who is on shift (a task made now, not a checklist)
  const shifts = people.some((p) => p.on_shift !== undefined);
  const option = (p: Person) => (
    <option key={p.user_id} value={p.user_id}>
      {p.name}
      {p.job_role ? ` (${p.job_role})` : ''}
    </option>
  );
  const modes = [
    ['person', 'A person'],
    ['job_role', 'A job role'],
    ['on_shift', 'Whoever is on shift'],
  ] as const;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">For</legend>
      <div className="grid grid-cols-3 gap-2">
        {modes.map(([mode, label]) => (
          <label
            key={mode}
            className={`flex min-h-11 items-center justify-center rounded-lg px-2 text-center text-sm ring-1 ${
              value.mode === mode
                ? 'bg-brand-700 text-white ring-brand-700'
                : 'bg-white ring-slate-300'
            }`}
          >
            <input
              type="radio"
              name="assign-mode"
              className="sr-only"
              checked={value.mode === mode}
              onChange={() =>
                onChange(
                  mode === 'person'
                    ? // someone on shift today, never whoever is first by name (ADR 113)
                      {
                        mode,
                        user_id:
                          (shifts ? people.find((p) => p.on_shift) : people[0])?.user_id ?? '',
                      }
                    : mode === 'job_role'
                      ? { mode, role: roles[0]?.code ?? '' }
                      : { mode },
                )
              }
            />
            {label}
          </label>
        ))}
      </div>
      {value.mode === 'person' && (
        <>
          <select
            aria-label="Person"
            value={value.user_id}
            onChange={(e) => onChange({ mode: 'person', user_id: e.target.value })}
            className={inputClass}
          >
            {!value.user_id && <option value="">Choose…</option>}
            {shifts ? (
              <>
                <optgroup label="On shift today">
                  {people.filter((p) => p.on_shift).map(option)}
                </optgroup>
                <optgroup label="Not on shift today">
                  {people.filter((p) => !p.on_shift).map(option)}
                </optgroup>
              </>
            ) : (
              people.map(option)
            )}
          </select>
          {shifts && !people.some((p) => p.on_shift) && (
            <p className="text-sm text-amber-800" data-testid="nobody-on-shift">
              No one is on shift here today.
            </p>
          )}
          {shifts && people.find((p) => p.user_id === value.user_id)?.on_shift === false && (
            <p className="text-sm text-amber-800" data-testid="not-on-shift">
              They aren&apos;t on shift today.
            </p>
          )}
        </>
      )}
      {value.mode === 'job_role' && (
        <select
          aria-label="Job role"
          value={value.role}
          onChange={(e) => onChange({ mode: 'job_role', role: e.target.value })}
          className={inputClass}
        >
          {roles.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
      )}
      {value.mode !== 'person' && (
        <p className="text-xs text-slate-500">
          {value.mode === 'job_role'
            ? 'Everyone in the role here sees it; the first to start takes it.'
            : 'Everyone rostered here when it is due sees it; the first to start takes it.'}
        </p>
      )}
    </fieldset>
  );
}
