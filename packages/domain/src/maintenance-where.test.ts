import { describe, expect, it } from 'vitest';
import { whereForPlace } from './maintenance-where';

describe('where a problem report starts (ADR 125)', () => {
  it('is the location of the department the person works in', () => {
    expect(whereForPlace('TEST-HOTEL-1.0-KITCHEN')).toBe('kitchen');
    expect(whereForPlace('PASSPORT-ASSAGAO-BAR')).toBe('bar');
    expect(whereForPlace('TEST-HOTEL-1.0-FRONT-OFFICE')).toBe('common_areas');
    expect(whereForPlace('TEST-HOTEL-1.0-HOUSEKEEPING')).toBe('laundry');
  });
  it('is nothing where the place names no department', () => {
    expect(whereForPlace('TEST-HOTEL-1.0')).toBeNull();
    expect(whereForPlace(null)).toBeNull();
  });
});
