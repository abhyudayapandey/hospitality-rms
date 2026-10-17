import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Which meal is next (ADR 121) goes by the outlet's 04:00 business day (ADR 169): a dinner
// that ends after midnight is still tonight's until it ends, and from 00:00 to 04:00 the next
// breakfast is the morning's, not tomorrow's.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const OUTLET = 'TEST-HOTEL-1.0';

const next = async (c: PoolClient, meal: string, at: string) =>
  (
    await c.query<{ d: string }>(`select ops.meal_next($1, $2, $3::timestamptz)::text as d`, [
      ids.node(OUTLET),
      meal,
      at,
    ])
  ).rows[0]!.d;

const ends = (c: PoolClient, meal: string, time: string) =>
  c.query(
    `update core.tenant set settings = settings || jsonb_build_object($2::text, $3::text)
             where id = $1`,
    [ids.tenant(), `${meal}_ends`, time],
  );

describe('the next meal', () => {
  it('a dinner ending after midnight is tonight’s until it ends', async () => {
    await inRolledBackTx(async (c) => {
      await ends(c, 'dinner', '00:30');
      expect(await next(c, 'dinner', '2026-10-05T21:00:00+05:30')).toBe('2026-10-05');
      expect(await next(c, 'dinner', '2026-10-06T00:15:00+05:30')).toBe('2026-10-05');
      expect(await next(c, 'dinner', '2026-10-06T00:45:00+05:30')).toBe('2026-10-06');
    });
  });

  it('the usual cut-offs: today until it ends, then the next day', async () => {
    await inRolledBackTx(async (c) => {
      await ends(c, 'dinner', '23:30');
      await ends(c, 'breakfast', '12:00');
      expect(await next(c, 'dinner', '2026-10-05T23:00:00+05:30')).toBe('2026-10-05');
      expect(await next(c, 'dinner', '2026-10-05T23:45:00+05:30')).toBe('2026-10-06');
      expect(await next(c, 'dinner', '2026-10-06T01:00:00+05:30')).toBe('2026-10-06');
      expect(await next(c, 'breakfast', '2026-10-06T02:00:00+05:30')).toBe('2026-10-06');
      expect(await next(c, 'breakfast', '2026-10-06T12:30:00+05:30')).toBe('2026-10-07');
    });
  });
});
