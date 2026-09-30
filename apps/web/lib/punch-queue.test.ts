import { describe, expect, it } from 'vitest';
import {
  pending,
  replay,
  type PunchStore,
  type QueuedPunch,
  type SendOutcome,
} from './punch-queue';

function memoryStore(initial: QueuedPunch[]): PunchStore & { keys(): string[] } {
  const m = new Map(initial.map((p) => [p.idempotencyKey, p]));
  return {
    all: () => Promise.resolve([...m.values()]),
    put: (p) => Promise.resolve(void m.set(p.idempotencyKey, p)),
    remove: (k) => Promise.resolve(void m.delete(k)),
    keys: () => [...m.keys()].sort(),
  };
}

const punch = (key: string, action: 'in' | 'out', ts: string, userId = 'sam'): QueuedPunch => ({
  idempotencyKey: key,
  userId,
  action,
  lat: 12.97,
  lng: 77.59,
  accuracy: 10,
  clientTs: ts,
});

describe('offline punch queue', () => {
  it('replays the user’s punches oldest first and empties the queue', async () => {
    const store = memoryStore([
      punch('b', 'out', '2026-10-01T11:30:00Z'),
      punch('a', 'in', '2026-10-01T03:30:00Z'),
      punch('x', 'in', '2026-10-01T03:00:00Z', 'priya'),
    ]);
    const order: string[] = [];
    const r = await replay(store, 'sam', (p) => {
      order.push(p.idempotencyKey);
      return Promise.resolve({ kind: 'ok' });
    });
    expect(order).toEqual(['a', 'b']);
    expect(r).toEqual({ sent: 2, refused: [], remaining: 0 });
    expect(store.keys()).toEqual(['x']); // another user's punch is left for them
  });

  it('stops at the first unreachable punch so the order is kept', async () => {
    const store = memoryStore([
      punch('a', 'in', '2026-10-01T03:30:00Z'),
      punch('b', 'out', '2026-10-01T11:30:00Z'),
    ]);
    let calls = 0;
    const r = await replay(store, 'sam', () => {
      calls++;
      return Promise.resolve<SendOutcome>({ kind: 'unreachable' });
    });
    expect(calls).toBe(1);
    expect(r.remaining).toBe(2);
    expect(await pending(store, 'sam')).toHaveLength(2);
  });

  it('drops refused punches (retrying cannot help) and reports them', async () => {
    const store = memoryStore([
      punch('a', 'in', '2026-10-01T03:30:00Z'),
      punch('b', 'out', '2026-10-01T11:30:00Z'),
    ]);
    const r = await replay(store, 'sam', (p) =>
      Promise.resolve<SendOutcome>(
        p.idempotencyKey === 'a' ? { kind: 'refused', message: 'too old' } : { kind: 'ok' },
      ),
    );
    expect(r.sent).toBe(1);
    expect(r.refused.map((x) => x.punch.idempotencyKey)).toEqual(['a']);
    expect(store.keys()).toEqual([]);
  });
});
