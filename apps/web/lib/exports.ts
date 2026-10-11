import 'server-only';
import type { Cell } from './csv';
import { readRange, type DateRange } from './date-range';
import type { Tx } from './db';
import { minibarCharged, minibarUsage, usedWords } from './minibar';
import { reportToday } from './report-data';

// The lists' downloads (ADR 120): each reads through the same function as its screen, as the
// signed-in person, so a file holds exactly what the screen shows for the same days; a place the
// person may not open is refused there (NOT_AUTHORISED).

export interface Sheet {
  name: string;
  header: string[];
  rows: Cell[][];
}

type Run = (tx: Tx, q: URLSearchParams) => Promise<Sheet>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A place's id from the query, or a refusal. */
export function placeOf(q: URLSearchParams, key = 'outlet'): string {
  const v = q.get(key) ?? '';
  if (!UUID.test(v)) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  return v;
}

/** The days asked for, as the screen reads them. */
export async function daysOf(
  tx: Tx,
  q: URLSearchParams,
  node: string,
  days = 7,
): Promise<DateRange> {
  return readRange(
    { from: q.get('from') ?? undefined, to: q.get('to') ?? undefined },
    await reportToday(tx, node),
    days,
  );
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : '');

export const EXPORTS: Record<string, Run> = {
  minibar_charged: async (tx, q) => {
    const outlet = placeOf(q);
    const r = await daysOf(tx, q, outlet);
    return {
      name: `minibar-added-to-bills-${r.from}-${r.to}`,
      header: ['room', 'used', 'amount', 'checked_at', 'checked_by', 'added_at', 'added_by'],
      rows: (await minibarCharged(tx, outlet, r.from, r.to)).map((c) => [
        c.room,
        usedWords(c.used),
        c.charge,
        iso(c.checked_at),
        c.checked_by,
        iso(c.charged_at),
        c.charged_by,
      ]),
    };
  },
  minibar_usage: async (tx, q) => {
    const outlet = placeOf(q);
    const r = await daysOf(tx, q, outlet);
    return {
      name: `minibar-charged-to-guests-${r.from}-${r.to}`,
      header: ['item', 'unit', 'used', 'rooms', 'charged', 'cost', 'refilled'],
      rows: (await minibarUsage(tx, outlet, r.from, r.to)).map((u) => [
        u.item,
        u.unit,
        u.used,
        u.rooms,
        u.revenue,
        u.cost,
        u.refilled,
      ]),
    };
  },
};
