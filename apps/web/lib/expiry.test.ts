import { describe, expect, it } from 'vitest';
import { expiryShow, splitExpiry, type ExpiryBatch } from './expiry';

const batch = (name: string, at: string, expired: boolean, store = 's1'): ExpiryBatch => ({
  store_id: store,
  store: 'Kitchen Store',
  item_id: name,
  sku: name.toUpperCase(),
  name,
  unit: 'g',
  batch_no: '1',
  expires_at: at,
  remaining: '100',
  expired,
});

describe('splitExpiry (INV-12)', () => {
  it('expiring soonest first; expired most recently expired first; this store only', () => {
    const r = splitExpiry(
      [
        batch('late', '2026-10-06T04:00:00Z', false),
        batch('soon', '2026-10-04T04:00:00Z', false),
        batch('old', '2026-09-28T04:00:00Z', true),
        batch('recent', '2026-10-02T04:00:00Z', true),
        batch('elsewhere', '2026-10-04T01:00:00Z', false, 's2'),
      ],
      's1',
    );
    expect(r.expiring.map((b) => b.name)).toEqual(['soon', 'late']);
    expect(r.expired.map((b) => b.name)).toEqual(['recent', 'old']);
  });

  it('opens on the expiring list unless asked for the expired one', () => {
    expect(expiryShow('expired')).toBe('expired');
    expect(expiryShow(undefined)).toBe('expiring');
    expect(expiryShow('x')).toBe('expiring');
  });
});
