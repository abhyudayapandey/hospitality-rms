import { describe, expect, it } from 'vitest';
import { PACKAGE } from './index';

describe('@outlet-ops/ai', () => {
  it('loads', () => {
    expect(PACKAGE).toBe('@outlet-ops/ai');
  });
});
