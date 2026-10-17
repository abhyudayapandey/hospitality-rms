import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// A place's "today" is its 04:00 business day in its own time zone (ADR 169), as CLAUDE.md
// says: 02:00 on Tuesday is still Monday, and the database's UTC date plays no part.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

describe('ops.today_at', () => {
  it('is the business day in the place’s time zone', async () => {
    await inRolledBackTx(async (c) => {
      const at = async (now: string) =>
        (
          await c.query<{ d: string }>(`select ops.today_at($1, $2::timestamptz)::text as d`, [
            ids.node('TEST-HOTEL-1.0'),
            now,
          ])
        ).rows[0]!.d;
      expect(await at('2026-10-06T02:00:00+05:30')).toBe('2026-10-05');
      expect(await at('2026-10-06T04:00:00+05:30')).toBe('2026-10-06');
      // 23:00 UTC on the 5th is 04:30 on the 6th in India
      expect(await at('2026-10-05T23:00:00Z')).toBe('2026-10-06');
    });
  });
});
