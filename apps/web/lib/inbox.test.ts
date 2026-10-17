import { describe, expect, it, vi } from 'vitest';

// a stand-in for the database: each query's text, answered by `answer`
vi.mock('server-only', () => ({}));
vi.mock('./db', () => ({
  sql: (parts: TemplateStringsArray, ...values: unknown[]) => ({
    execute: (tx: { run: (q: string, v: unknown[]) => Promise<{ rows: unknown[] }> }) =>
      tx.run(parts.join('$'), values),
  }),
}));

const { inboxEntries } = await import('./inbox');

// The To do list's requests (ADR 169): the frontline ask behind each transfer and each
// store's levels are read in one query each, however many transfers wait, not two queries
// per transfer on every 30-second refresh; and Home reads them only for what it shows.

function fakeDb(answer: (sql: string, values: unknown[]) => unknown[]) {
  const seen: { q: string; values: unknown[] }[] = [];
  const db = {
    run: (q: string, values: unknown[]) => {
      seen.push({ q, values });
      return Promise.resolve({ rows: answer(q, values) });
    },
  };
  return { db, seen };
}

const transfer = (n: number) => ({
  request_id: `r${n}`,
  process_type: 'TRANSFER',
  step: 'store_approval',
  activated_at: new Date('2026-10-05T04:00:00Z'),
  amount: null,
  payload: {},
  subject_id: `t${n}`,
  delivery_node_id: null,
  approve_via: null,
  initiator_name: 'Sana',
});

const answer = (q: string, _values: unknown[]) =>
  q.includes('wf.my_inbox')
    ? Array.from({ length: 30 }, (_, i) => transfer(i))
    : q.includes('request_for_ask')
      ? [{ subject: 't0', asked_by: 'Sana Shaikh', note: 'Weekend party' }]
      : q.includes('request_levels')
        ? [
            {
              subject: 't0',
              item_id: 'i',
              name: 'Gin',
              base_uom: 'bottle',
              asked: '2',
              from_name: 'Main Store',
              from_on_hand: '10',
              to_name: 'Bar',
              to_on_hand: '1',
              to_par: '4',
            },
          ]
        : [];

describe('inboxEntries', () => {
  it('reads asks and levels for 30 transfers in one query each', async () => {
    const { db, seen } = fakeDb(answer);
    const rows = await inboxEntries(db as never, 'Asia/Kolkata');
    expect(rows).toHaveLength(30);
    expect(seen.filter((s) => s.q.includes('request_for_ask'))).toHaveLength(1);
    expect(seen.filter((s) => s.q.includes('request_levels'))).toHaveLength(1);
    expect(rows[0]!.forAsk).toBe('For Sana Shaikh: Weekend party');
    expect(rows[0]!.levels).toHaveLength(1);
    expect(rows[1]!.forAsk).toBeUndefined();
  });

  it('Home reads the details only for the requests it shows', async () => {
    const { db, seen } = fakeDb(answer);
    const rows = await inboxEntries(db as never, 'Asia/Kolkata', { detailsFor: 3 });
    expect(rows).toHaveLength(30);
    const ask = seen.find((s) => s.q.includes('request_for_ask'))!;
    expect(ask.values).toEqual([['t0', 't1', 't2']]);
    expect(rows[0]!.forAsk).toBe('For Sana Shaikh: Weekend party');
  });
});
