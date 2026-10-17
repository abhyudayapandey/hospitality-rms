import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_FAILED_EVENT, callAction, nextKey } from './call-action';

// The one way a screen calls a server action (ADR 169): a request that never reaches the
// server shows "No connection. Try again." where the person is, instead of the error page
// that threw their typed values away.

afterEach(() => vi.unstubAllGlobals());

describe('callAction', () => {
  it('passes the arguments and returns what the action returned', async () => {
    const action = vi.fn((a: string, n: number) =>
      Promise.resolve({ ok: true as const, data: `${a}${n}` }),
    );
    expect(await callAction(action, 'x', 2)).toEqual({ ok: true, data: 'x2' });
    expect(action).toHaveBeenCalledWith('x', 2);
  });

  it('a request that fails on the way is No connection, and the app is told', async () => {
    const seen = vi.fn();
    vi.stubGlobal('window', { dispatchEvent: seen });
    vi.stubGlobal(
      'CustomEvent',
      class {
        constructor(public type: string) {}
      },
    );
    const r = await callAction(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(r).toEqual({ ok: false, code: 'OFFLINE', message: 'No connection. Try again.' });
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ type: ACTION_FAILED_EVENT }));
  });

  it('an action the server no longer has (an older build) asks for a reload', async () => {
    const err = new Error('Server Action "abc" was not found on the server.');
    err.name = 'UnrecognizedActionError';
    expect(await callAction(() => Promise.reject(err))).toEqual({
      ok: false,
      code: 'APP_UPDATED',
      message: 'The app was updated. Reload, then try again.',
    });
  });

  it('an error the server threw is Something went wrong, not No connection', async () => {
    const err = Object.assign(new Error('An error occurred in the Server Components render.'), {
      digest: '12345',
    });
    expect(await callAction(() => Promise.reject(err))).toMatchObject({
      ok: false,
      code: 'UNEXPECTED',
    });
  });

  it('lets a redirect or not-found through to Next', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/login;307;',
    });
    await expect(callAction(() => Promise.reject(redirect))).rejects.toBe(redirect);
  });
});

describe('nextKey', () => {
  it('keeps the same key while a try failed, and takes a new one after it went through', () => {
    const ref = { current: null as { for: string; key: string } | null };
    const first = nextKey(ref, 'approve');
    expect(nextKey(ref, 'approve')).toBe(first);
    ref.current = null; // done: the next decision is a new one
    expect(nextKey(ref, 'approve')).not.toBe(first);
  });

  it('a different decision gets its own key', () => {
    const ref = { current: null as { for: string; key: string } | null };
    const approve = nextKey(ref, 'approve');
    expect(nextKey(ref, 'reject')).not.toBe(approve);
  });
});
