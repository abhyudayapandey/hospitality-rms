import { describe, expect, it } from 'vitest';
import { shelfLifeText, useByText } from './shelf-life';

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

  it("gives a batch's use-by as a date, in the place's time, or says Expired", () => {
    const now = new Date('2026-10-01T10:00:00Z');
    expect(useByText('2026-10-04T12:00:00Z', 'Asia/Kolkata', now)).toBe('Use by Sun, 4 Oct');
    // 23:30 UTC is already the next day in Kolkata
    expect(useByText('2026-10-01T23:30:00Z', 'Asia/Kolkata', now)).toBe('Use by Fri, 2 Oct');
    expect(useByText('2026-10-01T10:00:00Z', 'Asia/Kolkata', now)).toBe('Expired');
    expect(useByText('2026-09-30T10:00:00Z', 'Asia/Kolkata', now)).toBe('Expired');
  });
});
