import { describe, expect, it } from 'vitest';
import { PACKAGE } from './index';

describe('@outlet-ops/workflow', () => {
  it('loads', () => {
    expect(PACKAGE).toBe('@outlet-ops/workflow');
  });
});
