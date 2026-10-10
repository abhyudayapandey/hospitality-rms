'use client';

import { useState, type ReactNode } from 'react';
import { Icon } from './icon';

/**
 * Me's "More" tile (ADR 106): the screens that are not the person's own work, opened in place
 * under it. A button, not a link: it goes nowhere.
 */
export function MeMore({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <li>
        <button
          type="button"
          data-testid="me-more"
          aria-expanded={open}
          aria-controls="me-more-tiles"
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-22 w-full flex-col items-center justify-center gap-1.5 rounded-xl bg-white p-2 text-center text-sm font-medium shadow-sm ring-1 ring-slate-200"
        >
          <Icon name="dots" className="size-7 text-brand-700" />
          <span className="leading-tight">{open ? 'Less' : `More (${count})`}</span>
        </button>
      </li>
      {open && (
        <li className="col-span-3">
          <ul id="me-more-tiles" aria-label="More" className="grid grid-cols-3 gap-2">
            {children}
          </ul>
        </li>
      )}
    </>
  );
}
