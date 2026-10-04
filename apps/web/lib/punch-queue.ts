// Offline clock-in queue (LLD section 5, ADR 008). A punch that cannot reach the server is
// kept on the device with its original time and idempotency key, then replayed in order
// with source 'offline'. The server keeps the device time (if at most 24 h old) and
// returns the recorded result for a key it has already seen, so a replay that raced a
// slow request cannot punch twice. Browser-only; the replay logic is pure for tests.

export interface QueuedPunch {
  idempotencyKey: string;
  userId: string;
  action: 'in' | 'out';
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  clientTs: string;
  /** this browser's id and the phone model, for a clock-in (ATT-7, ADR 045) */
  deviceId?: string | null;
  deviceModel?: string | null;
  /** the selfie taken at clock-in, kept on the phone until the punch syncs (IndexedDB holds blobs) */
  selfie?: Blob | null;
  /** how many times uploading the selfie failed while online; after 3 the punch goes without it */
  selfieTries?: number;
}

export interface PunchStore {
  all(): Promise<QueuedPunch[]>;
  put(p: QueuedPunch): Promise<void>;
  remove(key: string): Promise<void>;
}

/** What sending one punch returned: accepted, refused with a code, or unreachable. */
export type SendOutcome =
  { kind: 'ok' } | { kind: 'refused'; message: string } | { kind: 'unreachable' };

export interface ReplayResult {
  sent: number;
  refused: { punch: QueuedPunch; message: string }[];
  remaining: number;
}

/**
 * Sends this user's queued punches oldest first. Accepted and refused punches leave the
 * queue (a refusal, e.g. INVALID_TIMESTAMP after 24 h, will not change on retry); the
 * first unreachable one stops the run so order is kept for the next attempt.
 */
export async function replay(
  store: PunchStore,
  userId: string,
  send: (p: QueuedPunch) => Promise<SendOutcome>,
): Promise<ReplayResult> {
  const mine = (await store.all())
    .filter((p) => p.userId === userId)
    .sort((a, b) => a.clientTs.localeCompare(b.clientTs));
  const result: ReplayResult = { sent: 0, refused: [], remaining: mine.length };
  for (const p of mine) {
    const r = await send(p);
    if (r.kind === 'unreachable') break;
    await store.remove(p.idempotencyKey);
    result.remaining--;
    if (r.kind === 'ok') result.sent++;
    else result.refused.push({ punch: p, message: r.message });
  }
  return result;
}

/** The queued punches of a user, oldest first. */
export async function pending(store: PunchStore, userId: string): Promise<QueuedPunch[]> {
  return (await store.all())
    .filter((p) => p.userId === userId)
    .sort((a, b) => a.clientTs.localeCompare(b.clientTs));
}

// ---------------------------------------------------------------------------
// IndexedDB store (browser)
// ---------------------------------------------------------------------------

const DB = 'outlet-ops';
const STORE = 'punch-queue';

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

export const indexedDbStore: PunchStore = {
  all: () => tx('readonly', (s) => s.getAll() as IDBRequest<QueuedPunch[]>),
  put: async (p) => {
    await tx('readwrite', (s) => s.put(p));
  },
  remove: async (key) => {
    await tx('readwrite', (s) => s.delete(key));
  },
};

/** Fired on window after the queue changes, so screens can re-read it. */
export const QUEUE_EVENT = 'oo-punch-queue';
