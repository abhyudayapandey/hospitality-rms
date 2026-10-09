import { describe, expect, it } from 'vitest';
import { packOf } from './pack';

describe('the pack on a count row (ADR 079)', () => {
  it('tells a bottle from a nip', () => {
    expect(packOf('bottle', 'ml', '750')).toEqual({ label: '750 ml bottle', icon: 'bottle' });
    expect(packOf('bottle', 'ml', '180')).toEqual({ label: '180 ml nip', icon: 'nip' });
    expect(packOf('nip', 'ml', 90)).toEqual({ label: '90 ml nip', icon: 'nip' });
    expect(packOf('can', 'ml', '330')).toEqual({ label: '330 ml can', icon: 'bottle' });
    expect(packOf('bottle', 'ml', '1000')).toEqual({ label: '1 L bottle', icon: 'bottle' });
  });

  it('a bag, a pack of several; nothing for what is counted by weight or one by one', () => {
    expect(packOf('bag', 'g', '5000')).toEqual({ label: '5 kg bag', icon: 'box' });
    expect(packOf('box', 'each', '12')).toEqual({ label: 'box of 12', icon: 'box' });
    expect(packOf('kg', 'g', '1000')).toBeNull();
    expect(packOf('each', 'each', '1')).toBeNull();
    expect(packOf('bottle', null, null)).toBeNull();
  });
});
