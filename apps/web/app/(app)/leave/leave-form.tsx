'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { addDays, daysInclusive, isIsoDate } from '@/lib/dates';
import { requestLeave } from '../roster/actions';

export interface LeaveTypeOption {
  id: string;
  name: string;
  available: number | null;
}

export function LeaveForm({ types, today }: { types: LeaveTypeOption[]; today: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const hydrated = useHydrated();
  const [type, setType] = useState(types[0]?.id ?? '');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // one key per form fill, so a double tap or a retry does not file twice
  const key = useRef(crypto.randomUUID());
  const chosen = types.find((t) => t.id === type);
  const days = isIsoDate(from) && isIsoDate(to) && to >= from ? daysInclusive(from, to) : 0;
  const over = chosen?.available != null && days > chosen.available;

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
      <h2 className="font-semibold">Request leave</h2>
      <label className="block text-sm">
        Type
        <select value={type} onChange={(e) => setType(e.target.value)} className={inputClass}>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.available === null ? '' : ` (${t.available} left)`}
            </option>
          ))}
        </select>
      </label>
      {/* tap a start and a length; the dates below are there to change (ADR 098) */}
      <div className="space-y-2" data-testid="leave-picks">
        <div className="grid grid-cols-2 gap-2">
          {[
            ['Today', today],
            ['Tomorrow', addDays(today, 1)],
          ].map(([label, day]) => (
            <button
              key={label}
              type="button"
              aria-pressed={from === day}
              onClick={() => {
                setFrom(day!);
                setTo(addDays(day!, Math.max(days, 1) - 1));
              }}
              className={`min-h-11 rounded-lg text-sm font-medium ring-1 ${from === day ? 'bg-brand-700 text-white ring-brand-700' : 'ring-slate-300'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={days === n}
              onClick={() => setTo(addDays(from, n - 1))}
              className={`min-h-11 rounded-lg text-sm font-medium ring-1 ${days === n ? 'bg-brand-700 text-white ring-brand-700' : 'ring-slate-300'}`}
            >
              {n} {n === 1 ? 'day' : 'days'}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => {
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
            onChange={(e) => setTo(e.target.value)}
            className={inputClass}
            required
          />
        </label>
      </div>
      <p
        className={`text-sm ${over ? 'text-rose-700' : 'text-slate-600'}`}
        data-testid="leave-days"
      >
        {days} calendar day{days === 1 ? '' : 's'}
        {chosen?.available != null ? ` · ${chosen.available} available` : ''}
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
