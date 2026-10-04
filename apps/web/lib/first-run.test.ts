import { describe, expect, it } from 'vitest';
import { FIRST_RUN, firstRunKey } from './first-run';

describe('the welcome card (UX-12)', () => {
  it('every role has three short lines', () => {
    for (const [profile, lines] of Object.entries(FIRST_RUN)) {
      expect(lines, profile).toHaveLength(3);
      for (const l of lines) expect(l.length, l).toBeLessThan(90);
    }
  });
  it('is remembered per role', () => {
    expect(firstRunKey('frontline')).not.toBe(firstRunKey('outlet'));
  });
});
