'use client';

import { useState } from 'react';

/**
 * Sign-out clears the service-worker caches in the browser, then asks the server to
 * clear the session and refresh cookies (and revoke Cognito tokens), then leaves.
 */
export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } finally {
      const res = await fetch('/auth/logout', { method: 'POST' });
      const { redirect } = (await res.json()) as { redirect: string };
      window.location.assign(redirect);
    }
  }
  return (
    <button
      type="button"
      onClick={() => void signOut()}
      disabled={busy}
      className="min-h-11 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
