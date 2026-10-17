import { describe, expect, it } from 'vitest';
import { isStale, markStale } from './stale-build';

describe('stale build', () => {
  it('stays stale once the version check says so, until the reload', () => {
    expect(isStale()).toBe(false);
    markStale();
    expect(isStale()).toBe(true);
  });
});
