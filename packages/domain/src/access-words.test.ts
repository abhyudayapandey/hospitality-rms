import { describe, expect, it } from 'vitest';
import { DOMAINS } from './access';
import { DOMAIN_WORDS, grantPlace, summariseAccess } from './access-words';

describe('access in plain words (profile, ADR 018)', () => {
  it('has words for every domain', () => {
    expect(DOMAINS.filter((d) => !DOMAIN_WORDS[d.code]).map((d) => d.code)).toEqual([]);
  });

  it('splits a grant into what you can change and what you can see, in domain order', () => {
    expect(
      summariseAccess([
        { domain: 'WORKERS', access: 'view' },
        { domain: 'ATTENDANCE', access: 'modify' },
        { domain: 'ROSTER', access: 'modify' },
      ]),
    ).toEqual({ change: ['rosters', 'attendance'], see: ['people'] });
  });

  it('names the place and whether it covers what is under it', () => {
    expect(grantPlace('Test Hotel & Bar 1.0', true)).toBe(
      'Test Hotel & Bar 1.0 and everything under it',
    );
    expect(grantPlace('Bar Store', false)).toBe('Bar Store only');
    expect(grantPlace(null, null)).toBe('Yourself, wherever you work');
  });
});
