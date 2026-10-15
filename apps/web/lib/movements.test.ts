import { describe, expect, it } from 'vitest';
import { movementLabel } from './movements';

describe('movementLabel', () => {
  it('names every movement in words, never its code', () => {
    expect(movementLabel('sales_depletion', null)).toBe('Sold');
    expect(movementLabel('production_in', null)).toBe('Made');
    expect(movementLabel('production_out', null)).toBe('Used to make');
    expect(movementLabel('receipt', 'opening balance')).toBe('Received');
    expect(movementLabel('wastage', 'worn_out')).toBe('Wastage · worn out');
    expect(movementLabel('something_new', null)).toBe('Something new');
  });
});
