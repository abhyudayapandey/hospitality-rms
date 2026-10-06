'use client';

import { useState } from 'react';
import { clearCaches, LeavingScreen } from './leaving-screen';

/**
 * Sign-out (ADR 056): the screen is covered at once; the service-worker caches are cleared
 * while the server clears the session and refresh cookies (it revokes the Cognito token
 * after answering); then the page is replaced, so Back does not return to the app.
 */
export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    let redirect = '/login';
    try {
      const [res] = await Promise.all([
        fetch('/auth/logout', { method: 'POST' }),
        clearCaches().catch(() => undefined),
      ]);
      redirect = ((await res.json()) as { redirect: string }).redirect;
    } finally {
      window.location.replace(redirect);
    }
  }
  return (
    <>
      <button
        type="button"
        onClick={() => void signOut()}
        disabled={busy}
        className="min-h-11 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100"
      >
        Sign out
      </button>
      {busy && <LeavingScreen />}
    </>
  );
}
