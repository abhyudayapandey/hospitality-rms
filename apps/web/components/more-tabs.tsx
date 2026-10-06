'use client';

import { useState, type ReactNode } from 'react';

/**
 * A row of tabs with "More" after the first ones: tapping it shows the rest in the same row
 * and it becomes "Less" (ADR 054). A text button, not a tab: it goes nowhere.
 */
export function MoreTabs({
  shown,
  more,
  open: initial,
}: {
  shown: ReactNode[];
  more: ReactNode[];
  /** open from the start: the screen you are on is one of the rest */
  open: boolean;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <ul className="flex flex-wrap items-center gap-2">
      {shown}
      {open && more}
      {more.length > 0 && (
        <li>
          <button
            type="button"
            data-testid="tabs-more"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="flex min-h-11 items-center gap-1 px-2 text-sm font-medium text-brand-700"
          >
            {open ? 'Less' : `More (${more.length})`}
            <span aria-hidden="true">{open ? '▴' : '▾'}</span>
          </button>
        </li>
      )}
    </ul>
  );
}
