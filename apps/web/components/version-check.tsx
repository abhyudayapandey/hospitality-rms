'use client';

import { useEffect, useState } from 'react';

/** The build this page's code came from; the server says its own at /api/version. */
const MINE = process.env.NEXT_PUBLIC_BUILD_ID ?? '';

/**
 * After a deploy, someone who kept the app open is still running the old code. This asks the
 * server which build it runs when the app comes back to the screen and every 5 minutes, and
 * offers a reload when it differs (ADR 055).
 */
export function VersionCheck() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!MINE) return;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await fetch('/api/version', { cache: 'no-store' });
        if (!r.ok || !r.headers.get('content-type')?.includes('application/json')) return;
        const { build } = (await r.json()) as { build?: string };
        if (build && build !== MINE) setStale(true);
      } catch {
        // offline: ask again later
      }
    };
    const run = () => void check();
    run();
    const t = setInterval(run, 5 * 60_000);
    document.addEventListener('visibilitychange', run);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', run);
    };
  }, []);

  if (!stale) return null;
  return (
    <div
      role="alert"
      data-testid="new-version"
      className="fixed inset-x-0 bottom-20 z-40 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl bg-brand-700 px-4 py-3 text-sm text-white shadow-lg"
    >
      <span>A new version of the app is ready.</span>
      <button
        type="button"
        onClick={() => location.reload()}
        className="min-h-11 rounded-lg bg-white px-4 font-semibold text-brand-700"
      >
        Reload
      </button>
    </div>
  );
}
