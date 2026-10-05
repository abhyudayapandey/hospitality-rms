'use client';

import { useEffect, useState } from 'react';
import { FIRST_RUN, firstRunKey } from '@/lib/first-run';
import type { NavProfile } from '@/lib/nav';

/**
 * Three lines for the person's role, once. Dismissed for good on this phone (localStorage:
 * a convenience, so a blocked or cleared store only means it shows again).
 */
export function FirstRun({ profile }: { profile: NavProfile }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      if (!localStorage.getItem(firstRunKey(profile))) setShow(true);
    } catch {
      setShow(true);
    }
  }, [profile]);
  if (!show) return null;
  const done = () => {
    try {
      localStorage.setItem(firstRunKey(profile), '1');
    } catch {
      /* shows again next time */
    }
    setShow(false);
  };
  return (
    <section
      aria-label="Welcome"
      className="space-y-2 rounded-2xl bg-sky-50 p-4 ring-1 ring-sky-200"
      data-testid="first-run"
    >
      <h2 className="font-semibold">Welcome</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
        {FIRST_RUN[profile].map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={done}
        className="min-h-11 rounded-lg bg-white px-4 text-sm font-medium ring-1 ring-slate-300"
        data-testid="first-run-done"
      >
        Got it
      </button>
    </section>
  );
}
