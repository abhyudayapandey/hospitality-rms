import { afterAll, describe, expect, it } from 'vitest';
import { closePools, inRolledBackTx } from '../test/helpers';
import { everyone, refusalLeaks } from '../test/report-access';

// Every report refuses, for every person of both test customers, each place it does not
// list for them (R-1 to R-4: ADR 023, ADR 028, ADR 030, ADR 031). Split from reports-access.db.test.ts, which
// checks the lists against the rules, and in 2 parts by person (this is part 2), so the
// parts run side by side (ADR 029, 052).

afterAll(closePools);

describe('reports: every place not listed is refused (every user, part 2 of 2)', () => {
  it('a report refuses every place it does not list', async () => {
    await inRolledBackTx(async (c) => {
      const people = (await everyone(c)).filter((_, i) => i % 2 === 2 - 1);
      expect(people.length).toBeGreaterThan(0);
      expect(await refusalLeaks(c, people)).toEqual([]);
    });
  }, 600_000);
});
