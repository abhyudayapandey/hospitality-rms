import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// The order desk's tiles on Home go to whoever keeps a Main Store (ADR 151): the store keeper
// and the purchase manager, never a department head who keeps their own department's store.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

describe('inv.keeps_main_store', () => {
  it.each([
    ['test.purchase-manager.1.0', true],
    ['test.store-keeper.1.0', true],
    ['test.bar-manager.1.0', false],
    ['test.executive-chef.1.0', false],
    ['test.solo.accountant', false],
  ])('%s keeps a Main Store: %s', async (user, keeps) => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs<{ k: boolean }>(
        c,
        ids.user(user),
        'select inv.keeps_main_store() as k',
      );
      expect(r.error).toBeUndefined();
      expect(r.rows![0]!.k).toBe(keeps);
    });
  });
});
