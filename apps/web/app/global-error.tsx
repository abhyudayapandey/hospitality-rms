'use client';

import { DEFAULT_THEME } from '@/lib/theme';
import './globals.css';

// When even the app's frame cannot load (the database restarting during a deploy, ADR 169):
// plain words and a way to try again, never the framework's unstyled "Application error".
// It replaces the root layout, so it brings its own page.
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" data-theme={DEFAULT_THEME}>
      <body className="min-h-dvh bg-slate-50 text-slate-900 antialiased">
        <main className="mx-auto max-w-md space-y-4 px-4 py-12 text-center" data-testid="app-down">
          <h1 className="text-lg font-semibold">Hey Senior can’t open right now</h1>
          <p className="text-sm text-slate-600">
            This is on our side, not your phone. Wait a minute, then try again.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="min-h-12 w-full rounded-xl bg-brand-700 font-semibold text-white"
          >
            Try again
          </button>
          {/* a full load, in case the frame itself needs fetching again */}
          <a href="/" className="block text-sm font-medium text-brand-700 underline">
            Home
          </a>
        </main>
      </body>
    </html>
  );
}
