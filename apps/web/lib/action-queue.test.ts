import { describe, expect, it } from 'vitest';
import {
  pending,
  replay,
  waitingLines,
  type ActionStore,
  type QueuedAction,
  type QueuedCheckLine,
} from './action-queue';

function memoryStore(initial: QueuedAction[]): ActionStore & { keys(): string[] } {
  const m = new Map(initial.map((a) => [a.idempotencyKey, a]));
  return {
    all: () => Promise.resolve([...m.values()]),
    put: (a) => Promise.resolve(void m.set(a.idempotencyKey, a)),
    remove: (k) => Promise.resolve(void m.delete(k)),
    keys: () => [...m.keys()].sort(),
  };
}

const line = (
  key: string,
  ts: string,
  item = 'gin',
  counted = 5,
  userId = 'sam',
): QueuedCheckLine => ({
  kind: 'check_line',
  idempotencyKey: key,
  userId,
  clientTs: ts,
  check: 'c1',
  item,
  counted,
  full: null,
  tenths: null,
  area: null,
  device: 'phone-1',
  photoKey: null,
});

describe('offline count and wastage queue', () => {
  it('replays the user’s actions oldest first with their original times', async () => {
    const store = memoryStore([
      line('b', '2026-10-01T11:30:00Z'),
      line('a', '2026-10-01T03:30:00Z'),
      {
        kind: 'wastage',
        idempotencyKey: 'w',
        userId: 'sam',
        clientTs: '2026-10-01T05:00:00Z',
        node: 'n',
        lines: [{ item_id: 'gin', qty: 1, reason: 'spoiled' }],
      },
      line('x', '2026-10-01T03:00:00Z', 'rum', 1, 'priya'),
    ]);
    const order: string[] = [];
    const r = await replay(store, 'sam', (a) => {
      order.push(`${a.idempotencyKey}@${a.clientTs}`);
      return Promise.resolve({ kind: 'ok' });
    });
    expect(order).toEqual([
      'a@2026-10-01T03:30:00Z',
      'w@2026-10-01T05:00:00Z',
      'b@2026-10-01T11:30:00Z',
    ]);
    expect(r).toEqual({ sent: 3, refused: [], remaining: 0 });
    expect(store.keys()).toEqual(['x']);
  });

  it('stops at the first unreachable action so the order is kept', async () => {
    const store = memoryStore([
      line('a', '2026-10-01T03:30:00Z'),
      line('b', '2026-10-01T04:30:00Z'),
    ]);
    const r = await replay(store, 'sam', () => Promise.resolve({ kind: 'unreachable' }));
    expect(r).toEqual({ sent: 0, refused: [], remaining: 2 });
    expect(store.keys()).toEqual(['a', 'b']);
  });

  it('drops a refused action and says why', async () => {
    const store = memoryStore([line('a', '2026-10-01T03:30:00Z')]);
    const r = await replay(store, 'sam', () =>
      Promise.resolve({ kind: 'refused', message: 'The counts are locked.' }),
    );
    expect(r.refused.map((f) => f.message)).toEqual(['The counts are locked.']);
    expect(store.keys()).toEqual([]);
  });

  it('lists a user’s waiting actions and the latest waiting count per item', async () => {
    const store = memoryStore([
      line('a', '2026-10-01T03:30:00Z', 'gin', 5),
      line('b', '2026-10-01T04:30:00Z', 'gin', 6),
    ]);
    const waiting = await pending(store, 'sam');
    expect(waitingLines(waiting, 'c1').get('gin')?.counted).toBe(6);
    expect(waitingLines(waiting, 'other').size).toBe(0);
  });
});
