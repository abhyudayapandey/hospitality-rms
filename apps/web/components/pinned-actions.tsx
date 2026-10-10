import type { ReactNode } from 'react';

/**
 * A long list's main actions kept in reach (ADR 101). It sits after the list, as every
 * screen's actions do (ADR 051), and is sticky: while the list runs past the screen it stays
 * pinned just above the bottom nav; at the list's end it settles in its own place. A short
 * list never moves it.
 */
export function PinnedActions({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      role="region"
      aria-label={label}
      data-testid="pinned-actions"
      className="sticky bottom-[calc(3.5rem+1px+env(safe-area-inset-bottom))] z-[5] -mx-4 border-t border-slate-200 bg-slate-50 px-4 py-2"
    >
      {children}
    </div>
  );
}
