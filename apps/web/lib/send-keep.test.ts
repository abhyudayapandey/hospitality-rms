import { describe, expect, it } from 'vitest';
import { toKeepLevel } from './send-keep';

describe('Fill to keep level (ADR 053)', () => {
  it('fills what brings the department up to its keep level', () => {
    expect(toKeepLevel({ on_hand: '50', to_on_hand: '2', to_keep: '10' })).toBe(8);
  });
  it('never more than the Main Store has, never below zero', () => {
    expect(toKeepLevel({ on_hand: '3', to_on_hand: '2', to_keep: '10' })).toBe(3);
    expect(toKeepLevel({ on_hand: '50', to_on_hand: '12', to_keep: '10' })).toBe(0);
    expect(toKeepLevel({ on_hand: '50', to_on_hand: '0', to_keep: '0' })).toBe(0);
  });
  it('a department below zero is filled to its keep level, not past it', () => {
    expect(toKeepLevel({ on_hand: '50', to_on_hand: '-4', to_keep: '10' })).toBe(10);
  });
});
