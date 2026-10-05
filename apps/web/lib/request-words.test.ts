import { describe, expect, it } from 'vitest';
import { stepLabel } from './request-words';

describe('a step in plain words (ADR 053)', () => {
  it('never shows a step code', () => {
    expect(stepLabel('approval')).toBe('needs your approval');
    expect(stepLabel('dept_approval')).toBe('needs your approval');
    expect(stepLabel('dispatch')).toBe('to send');
    expect(stepLabel('receive')).toBe('to receive');
    expect(stepLabel('hr_review')).toBe('hr review');
  });
});
