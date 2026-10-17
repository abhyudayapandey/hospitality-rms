'use client';

import { useState } from 'react';
import {
  ErrorBox,
  inputClass,
  primaryButton,
  secondaryButton,
  StatusBox,
} from '@/components/messages';
import { clearCaches, LeavingScreen } from '@/components/leaving-screen';
import { passwordProblems } from '@/lib/auth/passwords';
import { changeOwnPassword, signOutEverywhere } from './actions';
import { PasswordInput } from '@/components/password-input';
import { callAction } from '@/lib/call-action';

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
    const r = await callAction(changeOwnPassword, { current, next, confirm });
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
      <div className="block text-sm">
        <label htmlFor="pw-current">Current password</label>
        <PasswordInput
          id="pw-current"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className={inputClass}
        />
      </div>
      <div className="block text-sm">
        <label htmlFor="pw-new">New password</label>
        <PasswordInput
          id="pw-new"
          autoComplete="new-password"
          required
          value={next}
          onChange={(e) => setNext(e.target.value)}
          aria-describedby="password-rule"
          className={inputClass}
        />
      </div>
      <p id="password-rule" className="text-xs text-slate-500">
        At least 10 characters, with a digit and a lower-case letter.
        {problems.length > 0 && (
          <span className="text-rose-700"> Still needs: {problems.join(', ')}.</span>
        )}
      </p>
      <div className="block text-sm">
        <label htmlFor="pw-again">New password again</label>
        <PasswordInput
          id="pw-again"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={inputClass}
        />
      </div>
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
    const r = await callAction(signOutEverywhere);
    if (!r.ok) {
      setBusy(false);
      setError(r.message);
      return;
    }
    await clearCaches().catch(() => undefined);
    window.location.replace(r.data);
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
      {busy && <LeavingScreen />}
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
