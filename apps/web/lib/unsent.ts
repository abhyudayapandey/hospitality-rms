import { indexedDbActions } from './action-queue';
import { indexedDbStore } from './punch-queue';

// What is saved on this phone and not sent yet (ADR 169): counts, wastage and clock-ins of
// anyone who used it. Signing out says so first, so a shared phone is not handed on with
// someone's work still on it unsent.

type Readable = { all(): Promise<unknown[]> };

export async function unsentCount(stores: readonly Readable[]): Promise<number> {
  const counts = await Promise.all(
    stores.map((s) =>
      s.all().then(
        (r) => r.length,
        () => 0,
      ),
    ),
  );
  return counts.reduce((a, b) => a + b, 0);
}

export const unsentWords = (n: number) =>
  n === 1
    ? '1 thing on this phone is not sent yet.'
    : `${n} things on this phone are not sent yet.`;

/** On this phone, now (0 without IndexedDB). */
export async function unsentOnPhone(): Promise<number> {
  if (typeof indexedDB === 'undefined') return 0;
  return unsentCount([indexedDbActions, indexedDbStore]);
}
