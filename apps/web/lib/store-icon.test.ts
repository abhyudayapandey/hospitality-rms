import { describe, expect, it } from 'vitest';
import { storeIcon } from './store-icon';

describe('storeIcon (ADR 100)', () => {
  it('pictures a store from its name', () => {
    expect(storeIcon('Bar')).toBe('glass');
    expect(storeIcon('Kitchen Store')).toBe('pot');
    expect(storeIcon('Housekeeping Store')).toBe('bed');
    expect(storeIcon('Banquets')).toBe('plate');
    expect(storeIcon('Banquet Store')).toBe('plate');
    expect(storeIcon('Main Store')).toBe('box');
  });
});
