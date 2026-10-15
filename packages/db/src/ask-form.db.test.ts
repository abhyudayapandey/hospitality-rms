import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// The staff ask's list (ADR 153): each item's category and par, so the form puts what runs short
// first and the rest by category; and the kind of outlet, for the note's example.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

describe('the staff ask form', () => {
  it("lists what the store keeps with its category and par, only to the store's team", async () => {
    await inRolledBackTx(async (c) => {
      const store = ids.node('TEST-HOTEL-1.0-HOUSEKEEPING-STORE');
      const r = await attemptAs<{ name: string; category: string | null; par: string }>(
        c,
        ids.user('test.room-attendant.1.0'),
        'select name, category, par::text from inv.ask_store_items($1)',
        [store],
      );
      expect(r.error).toBeUndefined();
      expect(r.rows!.length).toBeGreaterThan(0);
      expect(r.rows!.some((x) => x.category)).toBe(true);
      expect(r.rows!.every((x) => Number(x.par) >= 0)).toBe(true);
      const other = await attemptAs(
        c,
        ids.user('test.bartender.3.0'),
        'select * from inv.ask_store_items($1)',
        [store],
      );
      expect(other.error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('says the kind of outlet the person works at', async () => {
    await inRolledBackTx(async (c) => {
      const kind = async (user: string) =>
        (
          await attemptAs<{ f: string | null }>(
            c,
            ids.user(user),
            'select core.my_outlet_format() as f',
          )
        ).rows![0]!.f;
      expect(await kind('test.room-attendant.1.0')).toBe('hotel');
      expect(await kind('test.bartender.3.0')).toBe('bar_pub');
    });
  });
});
