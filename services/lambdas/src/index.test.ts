import { describe, expect, it } from 'vitest';
import { aiRecommend, wfExecute } from './index';

describe('lambdas', () => {
  it('exports handlers', () => {
    expect(typeof wfExecute).toBe('function');
    expect(typeof aiRecommend).toBe('function');
  });
});
