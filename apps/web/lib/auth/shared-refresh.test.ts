import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedRefresh } from './shared-refresh';

// A page and its prefetches refresh one Cognito session once, not once each (ADR 169).

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('sharedRefresh', () => {
  it('requests together share one call, and one just behind reuses its answer', async () => {
    const run = vi.fn(() => Promise.resolve({ refreshToken: 'next' }));
    const all = await Promise.all([1, 2, 3].map(() => sharedRefresh('tok-a', run)));
    expect(all.map((t) => t.refreshToken)).toEqual(['next', 'next', 'next']);
    await sharedRefresh('tok-a', run);
    expect(run).toHaveBeenCalledTimes(1);
    // after 30 s the next refresh asks Cognito again
    await vi.advanceTimersByTimeAsync(30_000);
    await sharedRefresh('tok-a', run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a failed refresh is tried again on the next request', async () => {
    const run = vi
      .fn<() => Promise<{ refreshToken?: string }>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({});
    await expect(sharedRefresh('tok-b', run)).rejects.toThrow('down');
    await expect(sharedRefresh('tok-b', run)).resolves.toEqual({});
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('another person’s token is its own call', async () => {
    const run = vi.fn(() => Promise.resolve({}));
    await Promise.all([sharedRefresh('tok-c', run), sharedRefresh('tok-d', run)]);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
