import { describe, expect, it } from 'vitest';
import { warningPhrase, warningSentence } from './roster-warnings';

describe('rostering warnings in words', () => {
  it('names the person, or starts the phrase with a capital', () => {
    expect(warningSentence('Test Commis B 1.0', 'would have 52 h this week (limit 48 h)')).toBe(
      'Test Commis B 1.0 would have 52 h this week (limit 48 h).',
    );
    expect(warningPhrase('would have 9 h rest between shifts (needs 10 h)')).toBe(
      'Would have 9 h rest between shifts (needs 10 h)',
    );
  });
});
