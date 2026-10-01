import { describe, expect, it } from 'vitest';
import { shelfLifeText, timeLeftText } from './shelf-life';

describe('shelf life wording', () => {
  it('says days, or hours under a day, rounding down', () => {
    expect(shelfLifeText(72)).toBe('Use within 3 days');
    expect(shelfLifeText(24)).toBe('Use within 1 day');
    expect(shelfLifeText(36)).toBe('Use within 1 day');
    expect(shelfLifeText(47)).toBe('Use within 1 day');
    expect(shelfLifeText(12)).toBe('Use within 12 hours');
    expect(shelfLifeText(1)).toBe('Use within 1 hour');
    expect(shelfLifeText(null)).toBe('');
  });

  it('counts what is left of a batch, or says Expired', () => {
    const now = new Date('2026-10-01T10:00:00Z');
    expect(timeLeftText('2026-10-04T12:00:00Z', now)).toBe('Use within 3 days');
    expect(timeLeftText('2026-10-01T15:30:00Z', now)).toBe('Use within 5 hours');
    expect(timeLeftText('2026-10-01T10:20:00Z', now)).toBe('Use within 1 hour');
    expect(timeLeftText('2026-10-01T10:00:00Z', now)).toBe('Expired');
    expect(timeLeftText('2026-09-30T10:00:00Z', now)).toBe('Expired');
  });
});
