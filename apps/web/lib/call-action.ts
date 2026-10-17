import { useCallback, useRef } from 'react';
import { messageFor, type ErrorCode } from '@outlet-ops/domain';

// The one way a screen calls a server action (ADR 169). A request that never reaches the
// server (no signal, the server restarting) used to reject, and the error page replaced the
// screen with everything the person had typed. callAction turns that into a failure the
// screen shows in place, like any other refusal, so the form keeps its values and the
// person taps again. With the same idempotency key (useActionKey) a retry of a request that
// did arrive returns the first result instead of doing it twice.

export type CallFailure = { ok: false; code: ErrorCode; message: string };

/** Sent on window when a call fails before the server answers: VersionCheck asks at once. */
export const ACTION_FAILED_EVENT = 'outlet-ops:action-failed';

const fail = (code: ErrorCode): CallFailure => ({ ok: false, code, message: messageFor(code) });

export async function callAction<A extends unknown[], R>(
  action: (...args: A) => Promise<R>,
  ...args: A
): Promise<R | CallFailure> {
  try {
    return await action(...args);
  } catch (err) {
    const { digest, name } = (err ?? {}) as { digest?: unknown; name?: unknown };
    // redirect() and notFound() are thrown on purpose: Next handles them
    if (typeof digest === 'string' && digest.startsWith('NEXT_')) throw err;
    // the server answered with an error of its own (it is logged there)
    if (typeof digest === 'string') return fail('UNEXPECTED');
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ACTION_FAILED_EVENT));
    // a screen from an older build calls an action the new one does not have
    if (name === 'UnrecognizedActionError') return fail('APP_UPDATED');
    return fail('OFFLINE');
  }
}

type KeyRef = { current: { for: string; key: string } | null };

/** The idempotency key for `decision`: the same one until it went through (then `done`). */
export function nextKey(ref: KeyRef, decision = ''): string {
  if (ref.current?.for !== decision) ref.current = { for: decision, key: crypto.randomUUID() };
  return ref.current.key;
}

/**
 * One idempotency key per thing the person decides (a submit, an approve), kept across tries
 * until it goes through: `key()` when calling, `done()` after an ok result.
 */
export function useActionKey(): { key: (decision?: string) => string; done: () => void } {
  const ref = useRef<{ for: string; key: string } | null>(null);
  const key = useCallback((decision?: string) => nextKey(ref, decision), []);
  const done = useCallback(() => {
    ref.current = null;
  }, []);
  return { key, done };
}
