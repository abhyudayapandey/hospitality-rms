'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { isErrorCode, messageFor } from '@outlet-ops/domain';
import {
  ErrorBox,
  inputClass,
  primaryButton,
  secondaryButton,
  StatusBox,
} from '@/components/messages';
import { WARNING_CODES } from '@/lib/roster-warnings';
import { Icon } from '@/components/icon';
import { Initials } from '@/components/initials';
import { shiftIcon, shiftTypeHours, shiftTypeTimes, type ShiftTypeWords } from '@/lib/shift-types';
import { useHydrated } from '@/lib/use-hydrated';
import { repeatPattern, setDayShift } from '../actions';

export interface TileType extends ShiftTypeWords {
  template_id: string;
  role_code: string;
  runs: boolean;
}

export interface TileRow {
  worker_id: string;
  name: string;
  role_code: string;
  job_role: string | null;
  template_id: string | null;
  shift_id: string | null;
  shift_name: string | null;
  start: string | null;
  end: string | null;
}

const KIND: Record<TileType['shift_type'], string> = {
  straight: '',
  split: 'Split',
  panzer: 'Panzer',
};

/**
 * The roster by person (ADR 082): one row each, a tile per shift type of their job role in the
 * department, and Off. A tap puts them on it for the day; the database runs every roster rule
 * again, and a warning (rest, weekly hours) asks before going ahead. A role with no shift type
 * here gets Off and says so: another role's shift type is refused (ROLE_MISMATCH). A shift
 * they have that no tile stands for (added by hand) shows as its own tile, theirs, so Off is
 * lit only when they have no shift that day (ADR 097).
 */
export function PeopleTiles({
  day,
  types,
  people,
  canEdit,
}: {
  day: string;
  types: TileType[];
  people: TileRow[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<{
    worker: string;
    template: string | null;
    code: string;
    name: string;
  } | null>(null);

  const tap = (p: TileRow, template: string | null, accept: string[] = []) =>
    start(async () => {
      setError(null);
      setWarn(null);
      const r = await setDayShift(p.worker_id, day, template, accept);
      if (!r.ok) {
        if ((WARNING_CODES as readonly string[]).includes(r.code)) {
          setWarn({ worker: p.worker_id, template, code: r.code, name: p.name });
          return;
        }
        setError(`${p.name}: ${r.message}`);
        return;
      }
      router.refresh();
    });

  if (people.length === 0) {
    return <p className="text-sm text-slate-600">Nobody works in this department yet.</p>;
  }
  return (
    <div className="space-y-2" data-testid="people-tiles">
      <ErrorBox message={error} />
      {warn && (
        <div className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900" role="alert">
          <p>
            {warn.name}: {isErrorCode(warn.code) ? messageFor(warn.code) : warn.code}
          </p>
          <button
            type="button"
            className={secondaryButton}
            disabled={!hydrated || pending}
            onClick={() =>
              tap(
                people.find((p) => p.worker_id === warn.worker)!,
                warn.template,
                [warn.code],
              )
            }
          >
            Put them on anyway
          </button>
        </div>
      )}
      <ul className="space-y-2">
        {people.map((p) => {
          const tiles = types.filter((t) => t.role_code === p.role_code);
          const off = p.shift_id === null;
          // their shift that day when no tile stands for it (added by hand, or another role's)
          const other =
            !off && !tiles.some((t) => t.template_id === p.template_id)
              ? (types.find((t) => t.template_id === p.template_id) ?? null)
              : null;
          return (
            <li
              key={p.worker_id}
              className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-slate-200"
              data-testid="person-row"
              data-name={p.name}
            >
              <p className="flex items-center gap-2">
                <Initials name={p.name} className="size-8 text-xs" />
                <span className="min-w-0 flex-1 font-medium">{p.name}</span>
                {p.job_role && <span className="text-xs text-slate-500">{p.job_role}</span>}
              </p>
              {tiles.length === 0 && (
                <p className="text-xs text-slate-500" data-testid="no-shift-types">
                  No shift type for {p.job_role ?? 'their job'} here yet; add one to the
                  department&apos;s shifts to roster them by tile.
                </p>
              )}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {tiles.map((t) => {
                  const on = p.template_id === t.template_id;
                  return (
                    <button
                      key={t.template_id}
                      type="button"
                      disabled={!canEdit || !hydrated || pending}
                      onClick={() => !on && tap(p, t.template_id)}
                      aria-pressed={on}
                      data-testid="shift-tile"
                      data-type={t.shift_type}
                      className={`flex min-h-14 flex-col items-start justify-center rounded-lg px-3 py-1 text-left text-sm ring-1 ${
                        on
                          ? 'bg-brand-700 font-semibold text-white ring-brand-700'
                          : t.runs
                            ? 'bg-white ring-slate-300'
                            : 'bg-slate-50 text-slate-500 ring-slate-200'
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <Icon name={shiftIcon(t.shift_type, t.start, 'UTC')} className="size-4" />
                        {t.name}
                        {KIND[t.shift_type] && t.name !== KIND[t.shift_type]
                          ? ` · ${KIND[t.shift_type]}`
                          : ''}
                      </span>
                      <span className="text-xs tabular-nums">
                        {shiftTypeTimes(t)} · {shiftTypeHours(t)} h
                      </span>
                    </button>
                  );
                })}
                {(!off && p.template_id === null) || other ? (
                  <span
                    aria-pressed="true"
                    role="status"
                    data-testid="shift-tile"
                    data-type="other"
                    className="flex min-h-14 flex-col items-start justify-center rounded-lg bg-brand-700 px-3 py-1 text-left text-sm font-semibold text-white ring-1 ring-brand-700"
                  >
                    <span>{other?.name ?? p.shift_name ?? 'Shift'}</span>
                    <span className="text-xs tabular-nums">
                      {other ? shiftTypeTimes(other) : `${p.start}–${p.end}`}
                    </span>
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={!canEdit || !hydrated || pending}
                  onClick={() => !off && tap(p, null)}
                  aria-pressed={off}
                  data-testid="shift-tile"
                  data-type="off"
                  className={`flex min-h-14 items-center justify-center rounded-lg px-3 text-sm ring-1 ${
                    off
                      ? 'bg-slate-700 font-semibold text-white ring-slate-700'
                      : 'bg-white ring-slate-300'
                  }`}
                >
                  Off
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "Repeat this pattern from [date] to [date]" (ADR 082): this week onto the same weekdays. */
export function RepeatPattern({ node, monday }: { node: string; monday: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<{ name: string; day: string; code: string }[]>([]);
  const go = () =>
    start(async () => {
      setError(null);
      setDone(null);
      setSkipped([]);
      if (!from || !to) return setError('Choose both dates.');
      const r = await repeatPattern(node, monday, from, to);
      if (!r.ok) return setError(r.message);
      setDone(
        `${r.data.added} shift${r.data.added === 1 ? '' : 's'} added${
          r.data.skipped.length ? `; ${r.data.skipped.length} left out` : ''
        }.`,
      );
      setSkipped(r.data.skipped);
      router.refresh();
    });
  return (
    <form
      aria-label="Repeat this pattern"
      className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <p className="text-sm font-semibold">Repeat this week&apos;s pattern</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="text-xs text-slate-600">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-slate-600">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>
      <ErrorBox message={error} />
      <StatusBox message={done} />
      {skipped.length > 0 && (
        <ul className="space-y-1 text-sm text-amber-900" data-testid="repeat-skipped">
          {skipped.map((x) => (
            <li key={`${x.name}-${x.day}`}>
              {x.name}, {x.day}: {isErrorCode(x.code) ? messageFor(x.code) : x.code}
            </li>
          ))}
        </ul>
      )}
      <button type="submit" className={primaryButton} disabled={!hydrated || pending}>
        Repeat
      </button>
    </form>
  );
}
