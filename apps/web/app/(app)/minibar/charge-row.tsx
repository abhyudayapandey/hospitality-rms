'use client';

import { useState } from 'react';
import { formatMoney } from '@/lib/format';
import { ChargedButton } from './charged-button';
import { UsedLines } from './used-lines';

/**
 * A minibar charge to post, on Home (ADR 119): the room and the amount, then More and Added to
 * the bill. More shows what was used, at what price, and who checked it, in place.
 */
export function ChargeRow({
  id,
  room,
  charge,
  used,
  checked,
}: {
  id: string;
  room: string;
  /** null for whoever sees no money (KI-09) */
  charge: string | null;
  used: { item: string; qty: string; price?: string }[];
  checked: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="space-y-2 py-2" data-testid="home-charge" data-room={room}>
      <p className="flex items-baseline justify-between gap-2">
        <span className="font-bold tabular-nums">Room {room}</span>
        {charge !== null && (
          <span className="shrink-0 font-semibold tabular-nums">{formatMoney(charge)}</span>
        )}
      </p>
      {open && (
        <div data-testid="home-charge-more">
          <UsedLines used={used} prices />
          <p className="text-xs text-slate-500">{checked}</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="min-h-11 rounded-xl text-sm font-semibold ring-1 ring-slate-300"
        >
          {open ? 'Less' : 'More'}
        </button>
        <div>
          <ChargedButton id={id} />
        </div>
      </div>
    </li>
  );
}
