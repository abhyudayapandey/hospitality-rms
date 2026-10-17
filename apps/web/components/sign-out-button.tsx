'use client';

import { useState } from 'react';
import { unsentOnPhone, unsentWords } from '@/lib/unsent';
import { clearCaches, LeavingScreen } from './leaving-screen';

/**
 * Sign-out (ADR 056): the screen is covered at once; the service-worker caches are cleared
 * while the server clears the session and refresh cookies (it revokes the Cognito token
 * after answering); then the page is replaced, so Back does not return to the app.
 */
async function stopAlerts(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager?.getSubscription();
  await sub?.unsubscribe();
  try {
    // whoever signs in next is asked for themselves
    localStorage.removeItem('oo.alerts.asked');
    localStorage.removeItem('oo.alerts.synced');
  } catch {
    // storage off: nothing kept
  }
}

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  // things saved on the phone and not sent yet: said once, then a second tap signs out
  const [unsent, setUnsent] = useState<number | null>(null);
  async function signOut() {
    if (unsent === null) {
      const n = await unsentOnPhone().catch(() => 0);
      if (n > 0) return setUnsent(n);
    }
    setBusy(true);
    let redirect = '/login';
    try {
      const [res] = await Promise.all([
        fetch('/auth/logout', { method: 'POST' }),
        clearCaches().catch(() => undefined),
        // this phone stops showing the signed-out person's alerts (ADR 137)
        stopAlerts().catch(() => undefined),
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
        {unsent ? 'Sign out anyway' : 'Sign out'}
      </button>
      {unsent ? (
        <p role="alert" data-testid="unsent-on-phone" className="text-sm text-amber-800">
          {unsentWords(unsent)} Signing out keeps them on the phone; they are sent when this person
          signs in again with a connection.
        </p>
      ) : null}
      {busy && <LeavingScreen />}
    </>
  );
}
