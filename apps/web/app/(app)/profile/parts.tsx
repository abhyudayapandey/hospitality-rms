'use client';

import { useState } from 'react';
import {
  ErrorBox,
  inputClass,
  primaryButton,
  secondaryButton,
  StatusBox,
} from '@/components/messages';
import { passwordProblems } from '@/lib/auth/passwords';
import { changeOwnPassword, signOutEverywhere } from './actions';

export function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const problems = next ? passwordProblems(next) : [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    const r = await changeOwnPassword({ current, next, confirm });
    setBusy(false);
    if (r.ok) {
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } else {
      setError(r.message);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3" data-testid="password-form">
      <label className="block text-sm">
        Current password
        <input
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="block text-sm">
        New password
        <input
          type="password"
          autoComplete="new-password"
          required
          value={next}
          onChange={(e) => setNext(e.target.value)}
          aria-describedby="password-rule"
          className={inputClass}
        />
      </label>
      <p id="password-rule" className="text-xs text-slate-500">
        At least 10 characters, with a digit and a lower-case letter.
        {problems.length > 0 && (
          <span className="text-rose-700"> Still needs: {problems.join(', ')}.</span>
        )}
      </p>
      <label className="block text-sm">
        New password again
        <input
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={inputClass}
        />
      </label>
      <ErrorBox message={error} />
      <StatusBox
        message={done ? 'Password changed. Use the new one next time you sign in.' : null}
      />
      <button type="submit" disabled={busy} className={primaryButton}>
        {busy ? 'Changing…' : 'Change password'}
      </button>
    </form>
  );
}

export function SignOutEverywhere() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    const r = await signOutEverywhere();
    if (!r.ok) {
      setBusy(false);
      setError(r.message);
      return;
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    window.location.assign(r.data);
  }

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className={secondaryButton}>
        Sign out of all devices
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
      <p>You will be signed out on every phone and computer, including this one.</p>
      <ErrorBox message={error} />
      <button
        type="button"
        onClick={() => void go()}
        disabled={busy}
        className={primaryButton}
        data-testid="confirm-sign-out-everywhere"
      >
        {busy ? 'Signing out…' : 'Yes, sign out everywhere'}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={busy}
        className={secondaryButton}
      >
        Cancel
      </button>
    </div>
  );
}
