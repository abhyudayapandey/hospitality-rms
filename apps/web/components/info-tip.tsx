import type { ReactNode } from 'react';

/**
 * A rule or a reason behind a small "?" (ADR 098): the screen shows its title and its list, and
 * whoever wants the why taps for it. Plain HTML, so it works before the page is interactive.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="group text-sm text-slate-600" data-testid="info-tip">
      <summary
        className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 text-slate-500 [&::-webkit-details-marker]:hidden"
        aria-label={label}
      >
        <span className="flex size-7 items-center justify-center rounded-full font-bold ring-1 ring-slate-300">
          ?
        </span>
        <span className="text-xs">{label}</span>
      </summary>
      <p className="mt-1 rounded-lg bg-white p-3 ring-1 ring-slate-200">{children}</p>
    </details>
  );
}
