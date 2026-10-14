import { describe, expect, it } from 'vitest';
import { formatMoney } from '@/lib/format';
import { chargeWords } from './charge-words';

describe('chargeWords (KI-09)', () => {
  it('gives the rupees to whoever sees prices', () => {
    expect(
      chargeWords([
        { name: 'Cola', used: 1, price: '120' },
        { name: 'Lager', used: 2, price: '250' },
        { name: 'Water', used: 1, price: '0' },
      ]),
    ).toBe(formatMoney(620));
  });

  it('gives the items and counts, no rupees, to whoever sees no money', () => {
    const words = chargeWords([
      { name: 'Cola', used: 1, price: null },
      { name: 'Lager', used: 2, price: null },
      { name: 'Chips', used: 0, price: null },
      { name: 'Water', used: 1, price: '0' },
    ]);
    expect(words).toBe('Cola ×1, Lager ×2');
    expect(words).not.toContain('₹');
  });

  it('is null when nothing is charged', () => {
    expect(chargeWords([{ name: 'Cola', used: 0, price: null }])).toBeNull();
    expect(chargeWords([{ name: 'Water', used: 2, price: '0' }])).toBeNull();
  });
});
