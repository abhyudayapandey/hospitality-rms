// Offline queue for stock counts and wastage (INV-8, ADR 042), the same pattern as the
// clock-in punch queue (lib/punch-queue.ts, ADR 008). A count line or wastage entry that
// cannot reach the server is kept on the device with the time it happened and its
// idempotency key, then replayed oldest first. The server keeps the original time of a
// count line (the latest original time wins), and a wastage key it has seen returns the
// first result, so a replay that raced a slow request cannot post twice. Browser-only; the
// replay logic is pure for tests.

export interface QueuedCheckLine {
  kind: 'check_line';
  idempotencyKey: string;
  userId: string;
  clientTs: string;
  check: string;
  item: string;
  counted: number | null;
  full: number | null;
  tenths: number | null;
  area: string | null;
  device: string | null;
  photoKey: string | null;
}

export interface QueuedWastage {
  kind: 'wastage';
  idempotencyKey: string;
  userId: string;
  clientTs: string;
  node: string;
  lines: { item_id: string; qty: number; reason: string }[];
}

export type QueuedAction = QueuedCheckLine | QueuedWastage;

export interface ActionStore {
  all(): Promise<QueuedAction[]>;
  put(a: QueuedAction): Promise<void>;
  remove(key: string): Promise<void>;
}

export type SendOutcome =
  { kind: 'ok' } | { kind: 'refused'; message: string } | { kind: 'unreachable' };

export interface ReplayResult {
  sent: number;
  refused: { action: QueuedAction; message: string }[];
  remaining: number;
}

export async function pending(store: ActionStore, userId: string): Promise<QueuedAction[]> {
  return (await store.all())
    .filter((a) => a.userId === userId)
    .sort((a, b) => a.clientTs.localeCompare(b.clientTs));
}

/**
 * Sends this user's queued actions oldest first. Accepted and refused ones leave the queue
 * (a refusal, e.g. CHECK_LOCKED, will not change on retry); the first unreachable one stops
 * the run so order is kept for the next attempt.
 */
export async function replay(
  store: ActionStore,
  userId: string,
  send: (a: QueuedAction) => Promise<SendOutcome>,
): Promise<ReplayResult> {
  const mine = await pending(store, userId);
  const result: ReplayResult = { sent: 0, refused: [], remaining: mine.length };
  for (const a of mine) {
    const r = await send(a);
    if (r.kind === 'unreachable') break;
    await store.remove(a.idempotencyKey);
    result.remaining--;
    if (r.kind === 'ok') result.sent++;
    else result.refused.push({ action: a, message: r.message });
  }
  return result;
}

/** Waiting count lines of one check, newest value per item, for showing "saved on this phone". */
export function waitingLines(actions: QueuedAction[], check: string): Map<string, QueuedCheckLine> {
  const m = new Map<string, QueuedCheckLine>();
  for (const a of actions) {
    if (a.kind === 'check_line' && a.check === check) m.set(a.item, a);
  }
  return m;
}

// ---------------------------------------------------------------------------
// IndexedDB store (browser)
// ---------------------------------------------------------------------------

const DB = 'outlet-ops-actions';
const STORE = 'action-queue';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'idempotencyKey' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        t.onerror = () => {
          db.close();
          reject(t.error ?? new Error('indexedDB transaction failed'));
        };
      }),
  );
}

export const indexedDbActions: ActionStore = {
  all: () => tx('readonly', (s) => s.getAll() as IDBRequest<QueuedAction[]>),
  put: async (a) => {
    await tx('readwrite', (s) => s.put(a));
  },
  remove: async (key) => {
    await tx('readwrite', (s) => s.delete(key));
  },
};

/** Fired on window after the queue changes, so screens can re-read it. */
export const ACTION_QUEUE_EVENT = 'oo-action-queue';
