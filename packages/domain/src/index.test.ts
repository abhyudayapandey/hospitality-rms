import { describe, expect, it } from 'vitest';
import { PACKAGE } from './index';

describe('@outlet-ops/domain', () => {
  it('loads', () => {
    expect(PACKAGE).toBe('@outlet-ops/domain');
  });
});
