import { describe, expect, it } from 'vitest';
import { packAmount, packCount, packOf, wholePacks } from './pack';

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

describe('opened packs by whole packs (ADR 102)', () => {
  it('says a pack in words a cook uses', () => {
    expect(packAmount('0.4', 'l')).toBe('400 ml');
    expect(packAmount(0.8, 'l')).toBe('800 ml');
    expect(packAmount(1, 'l')).toBe('1 l');
    expect(packAmount('0.5', 'kg')).toBe('500 g');
    expect(packAmount(1, 'bottle')).toBe('1 bottle');
    expect(packCount(1, 'tin')).toBe('1 tin');
    expect(packCount(2, 'tin')).toBe('2 tins');
    expect(packCount(3, 'box')).toBe('3 boxes');
    expect(packCount(2, null)).toBe('2 packs');
  });
  it('counts whole packs only', () => {
    expect(wholePacks('0.8', '0.4')).toBe(2);
    expect(wholePacks('1.2', '0.4')).toBe(3);
    expect(wholePacks('0.5', '0.4')).toBeNull();
    expect(wholePacks(0, '0.4')).toBeNull();
  });
});
