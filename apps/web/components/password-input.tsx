'use client';

import { useState, type InputHTMLAttributes } from 'react';

// A password box with Show / Hide (ADR 163): on a phone a mistyped password is hard to find
// without seeing it. The box keeps every attribute it is given; only its type changes.
export function PasswordInput({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={shown ? 'text' : 'password'} className={`${className ?? ''} pr-20`} />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
        data-testid="password-toggle"
        className="absolute inset-y-0 right-0 flex min-w-16 items-center justify-center px-3 text-sm font-medium text-brand-700"
      >
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

/** A login has no spaces: they are dropped as the person types or pastes (ADR 163). */
export function noSpaces(e: { currentTarget: HTMLInputElement }) {
  const t = e.currentTarget;
  const v = t.value.replace(/\s+/g, '');
  if (v !== t.value) t.value = v;
}
