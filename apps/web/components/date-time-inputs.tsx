'use client';

import { useEffect, useRef, useState } from 'react';

// Dates and times as the app says them (ADR 162): a day as dd/mm/yyyy and a time on the 24-hour
// clock, whatever language the phone's browser is set to. The browser's own boxes follow the
// phone ("11:00 AM", "10/16/2026"), and a 12-hour box refused "11:00". These keep the values a
// form sends as they were (yyyy-mm-dd, HH:MM), so the pages behind them need no change.
// onChange gets { target: { value } } like an input's, so a box swaps in place.

type Change = (e: { target: { value: string } }) => void;

interface Common {
  id?: string;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "16/10/2026" for "2026-10-16"; '' for anything else. */
export function isoToDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** "2026-10-16" for "16/10/2026" (or an ISO day as it is); null when it is not a real day. */
export function dayToIso(text: string): string | null {
  const t = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  const [y, m, d] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : dmy
      ? [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])]
      : [0, 0, 0];
  if (!y) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Slashes as a day is typed on a number pad: "1610" -> "16/10/". */
export function typedDay(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return isoToDay(raw.trim());
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean);
  const text = parts.join('/');
  // a slash after a full day or month, so the next digit goes on
  return (digits.length === 2 || digits.length === 4) && raw.length > text.length
    ? `${text}/`
    : text;
}

/** "14:30" kept, "1430" -> "14:30"; a colon after two digits as they are typed. */
export function typedTime(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
}

/** Whether a time is a real one on the 24-hour clock ("23:59" yes, "24:00" no). */
export function isTime(text: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text);
}

/** A day, typed as dd/mm/yyyy on a number pad or picked from the phone's calendar. */
export function DateInput({
  value,
  defaultValue,
  onChange,
  min,
  max,
  ...rest
}: Common & {
  value?: string;
  defaultValue?: string;
  onChange?: Change;
  min?: string;
  max?: string;
}) {
  const [text, setText] = useState(() => isoToDay(value ?? defaultValue ?? ''));
  const sent = useRef(value ?? defaultValue ?? '');
  const box = useRef<HTMLInputElement>(null);
  // a value set from outside (a chip, Clear) shows; one this box sent is left as typed
  useEffect(() => {
    if (value !== undefined && value !== sent.current) {
      sent.current = value;
      setText(isoToDay(value));
    }
  }, [value]);
  const iso = dayToIso(text);
  const problem =
    text === ''
      ? ''
      : !iso
        ? 'Type the day as dd/mm/yyyy.'
        : min && iso < min
          ? `Pick ${isoToDay(min)} or later.`
          : max && iso > max
            ? `Pick ${isoToDay(max)} or earlier.`
            : '';
  useEffect(() => box.current?.setCustomValidity(problem), [problem]);
  const take = (next: string) => {
    setText(next);
    const day = dayToIso(next) ?? '';
    if (day !== sent.current) {
      sent.current = day;
      onChange?.({ target: { value: day } });
    }
  };
  return (
    <span className="relative flex items-center gap-2">
      <input
        ref={box}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="dd/mm/yyyy"
        value={text}
        onChange={(e) => take(typedDay(e.target.value))}
        // the box's own limits, as days (the calendar's too); checked below, not by the browser
        min={min}
        max={max}
        {...rest}
        name={undefined}
        className={`${rest.className ?? ''} min-w-0 flex-1`}
      />
      {rest.name && <input type="hidden" name={rest.name} value={iso ?? ''} />}
      {/* The calendar: the phone's own date box, invisible, laid over the icon at its size, so
          a tap opens the phone's calendar and it closes as it always does (ADR 164; a hidden
          box opened by script stayed open on some phones). Hidden from screen readers, so inside
          a label it never joins the box's name; the text box takes the typed day. */}
      <span
        aria-hidden="true"
        title="Pick from a calendar"
        className="relative flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg ring-1 ring-slate-300"
      >
        <svg
          viewBox="0 0 24 24"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
        <input
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="date-picker"
          className="date-over absolute inset-0 size-full cursor-pointer opacity-0"
          value={iso ?? ''}
          min={min}
          max={max}
          disabled={rest.disabled}
          onChange={(e) => take(isoToDay(e.target.value))}
        />
      </span>
    </span>
  );
}

/** A time on the 24-hour clock, typed on a number pad: "1430" reads "14:30". */
export function TimeInput({
  value,
  defaultValue,
  onChange,
  ...rest
}: Common & { value?: string; defaultValue?: string; onChange?: Change }) {
  const [own, setOwn] = useState(defaultValue ?? '');
  const text = value ?? own;
  const box = useRef<HTMLInputElement>(null);
  const problem = text === '' || isTime(text) ? '' : 'Type the time as 24-hour, like 14:30.';
  useEffect(() => box.current?.setCustomValidity(problem), [problem]);
  return (
    <input
      ref={box}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder="14:30"
      maxLength={5}
      value={text}
      onChange={(e) => {
        const next = typedTime(e.target.value);
        if (value === undefined) setOwn(next);
        onChange?.({ target: { value: next } });
      }}
      {...rest}
    />
  );
}
