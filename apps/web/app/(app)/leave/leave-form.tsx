'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { Icon, type IconName } from '@/components/icon';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { addDays, daysInclusive, formatDay, isIsoDate } from '@/lib/dates';
import { requestLeave } from '../roster/actions';

export interface LeaveTypeOption {
  id: string;
  name: string;
  available: number | null;
  /** its picture (lib/leave-icons, ADR 107) */
  icon: IconName;
}

/**
 * Asking for leave (ADR 112): tap the type, then the shifts you want off; the dates follow.
 * It starts on your next working day, never on a day you are off. Other dates are there to
 * change when the shift you want off isn't rostered yet.
 */
export function LeaveForm({
  types,
  today,
  shiftDays,
}: {
  types: LeaveTypeOption[];
  today: string;
  /** the days you are rostered on, from the next one, for two weeks */
  shiftDays: string[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const hydrated = useHydrated();
  const first = shiftDays[0] ?? addDays(today, 1);
  const [type, setType] = useState(types[0]?.id ?? '');
  const [picked, setPicked] = useState<string[]>([first]);
  const [from, setFrom] = useState(first);
  const [to, setTo] = useState(first);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // one key per form fill, so a double tap or a retry does not file twice
  const key = useRef(crypto.randomUUID());
  const chosen = types.find((t) => t.id === type);
  const days = isIsoDate(from) && isIsoDate(to) && to >= from ? daysInclusive(from, to) : 0;
  const over = chosen?.available != null && days > chosen.available;

  const toggle = (d: string) => {
    const next = picked.includes(d) ? picked.filter((x) => x !== d) : [...picked, d];
    const sorted = next.sort();
    setPicked(sorted);
    if (sorted.length > 0) {
      setFrom(sorted[0]!);
      setTo(sorted[sorted.length - 1]!);
    }
  };

  const submit = () =>
    start(async () => {
      setError(null);
      const r = await requestLeave(type, from, to, reason, key.current);
      if (!r.ok) return setError(r.message);
      key.current = crypto.randomUUID();
      setDone('Leave requested. Your manager has been asked to approve it.');
      setReason('');
      router.refresh();
    });

  return (
    <form
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      aria-label="Request leave"
    >
      <h2 className="font-semibold">Ask for leave</h2>
      <div role="group" aria-label="Type" className="flex flex-wrap gap-2">
        {types.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={type === t.id}
            onClick={() => setType(t.id)}
            className={`inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm ring-1 ${
              type === t.id
                ? 'bg-brand-700 font-semibold text-white ring-brand-700'
                : 'bg-white ring-slate-300'
            }`}
          >
            <Icon name={t.icon} className="size-5" />
            {t.name}
            {t.available !== null && ` · ${t.available} left`}
          </button>
        ))}
      </div>
      {shiftDays.length > 0 && (
        <div className="space-y-1" data-testid="leave-shifts">
          <span className="text-sm font-medium">Tap the shifts you want off</span>
          <div role="group" aria-label="Your shifts" className="flex flex-wrap gap-2">
            {shiftDays.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={picked.includes(d)}
                onClick={() => toggle(d)}
                className={`min-h-11 rounded-full px-3 text-sm tabular-nums ring-1 ${
                  picked.includes(d)
                    ? 'bg-brand-700 font-semibold text-white ring-brand-700'
                    : 'bg-white ring-slate-300'
                }`}
              >
                {formatDay(d)}
              </button>
            ))}
          </div>
        </div>
      )}
      <details open={shiftDays.length === 0} data-testid="leave-dates">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
          Other dates
        </summary>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setPicked([]);
                setFrom(e.target.value);
                if (e.target.value > to) setTo(e.target.value);
              }}
              className={inputClass}
              required
            />
          </label>
          <label className="block text-sm">
            To
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => {
                setPicked([]);
                setTo(e.target.value);
              }}
              className={inputClass}
              required
            />
          </label>
        </div>
      </details>
      <p
        className={`text-sm ${over ? 'text-rose-700' : 'text-slate-600'}`}
        data-testid="leave-days"
      >
        {days} calendar day{days === 1 ? '' : 's'}
        {days > 0 && ` · ${formatDay(from)}${to !== from ? ` – ${formatDay(to)}` : ''}`}
      </p>
      <label className="block text-sm">
        Reason (optional)
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          className={inputClass}
        />
      </label>
      <button
        type="submit"
        disabled={!hydrated || pending || days === 0 || over || !type}
        className={primaryButton}
      >
        Request {days || ''} day{days === 1 ? '' : 's'}
      </button>
      <ErrorBox message={error} />
      <StatusBox message={done} />
    </form>
  );
}
