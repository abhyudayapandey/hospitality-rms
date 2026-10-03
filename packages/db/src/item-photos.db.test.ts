import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  migratorPool,
  type SeedIds,
} from '../test/helpers';

// Item photos (UX-6, ADR 034): a picture of each item on stock lists, counts and prep. A
// photo is set, changed or cleared with inv.set_item_photo, only by someone who records
// stock changes (STOCK_ADJUSTMENTS modify) at a store that carries the item. The key must be
// the company's and the item's own (items/<tenant>/<item>/<uuid>.<ext>), so one company can
// never point at another's photo. inv.can_set_item_photo answers the same question before
// the app asks S3 for an upload URL. Every change is in the audit log (rule 5).

let ids: SeedIds;
let onions: string;
let soloItem: string;
beforeAll(async () => {
  ids = await loadSeedIds();
  const r = await migratorPool.query<{ id: string; tenant_id: string }>(
    `select id, tenant_id from inv.item where sku = 'ONIONS'`,
  );
  onions = r.rows.find((x) => x.tenant_id === ids.tenant())!.id;
  const s = await migratorPool.query<{ id: string }>(
    `select i.id from inv.item i where i.tenant_id = $1 order by i.sku limit 1`,
    [ids.tenant('TEST-SOLO-COMPANY')],
  );
  soloItem = s.rows[0]!.id;
});
afterAll(closePools);

const key = (tenant: string, item: string, ext = 'jpg') =>
  `items/${tenant}/${item}/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.${ext}`;

describe('item photos (UX-6)', () => {
  it('a chef at a store that carries the item sets, changes and clears its photo', async () => {
    await inRolledBackTx(async (c) => {
      const chef = ids.user('test.executive-chef.1.0');
      const k = key(ids.tenant(), onions);
      const can = await attemptAs<{ ok: boolean }>(
        c,
        chef,
        'select inv.can_set_item_photo($1::uuid) as ok',
        [onions],
      );
      expect(can.rows?.[0]?.ok).toBe(true);
      const r = await attemptAs(c, chef, 'select inv.set_item_photo($1::uuid, $2)', [onions, k]);
      expect(r.error).toBeUndefined();
      const after = await c.query<{ photo_key: string }>(
        'select photo_key from inv.item where id = $1',
        [onions],
      );
      expect(after.rows[0]!.photo_key).toBe(k);
      // what the person sees: the key on the item, under RLS
      const seen = await attemptAs<{ photo_key: string }>(
        c,
        ids.user('test.store-keeper.1.0'),
        'select photo_key from inv.item where id = $1',
        [onions],
      );
      expect(seen.rows?.[0]?.photo_key).toBe(k);
      // audited (rule 5)
      const audit = await c.query(
        `select 1 from audit.log where table_name = 'inv.item' and row_id = $1
            and op = 'UPDATE' and actor_id = $2`,
        [onions, chef],
      );
      expect(audit.rowCount).toBeGreaterThan(0);
      const cleared = await attemptAs(c, chef, 'select inv.set_item_photo($1::uuid, null)', [
        onions,
      ]);
      expect(cleared.error).toBeUndefined();
      const gone = await c.query<{ photo_key: string | null }>(
        'select photo_key from inv.item where id = $1',
        [onions],
      );
      expect(gone.rows[0]!.photo_key).toBeNull();
    });
  });

  it('refuses people who do not record stock changes where the item is kept', async () => {
    await inRolledBackTx(async (c) => {
      for (const u of ['test.commis.1.0', 'test.server.3.0', 'test.hr-admin']) {
        const can = await attemptAs<{ ok: boolean }>(
          c,
          ids.user(u),
          'select inv.can_set_item_photo($1::uuid) as ok',
          [onions],
        );
        expect(can.rows?.[0]?.ok, u).toBe(false);
        const r = await attemptAs(c, ids.user(u), 'select inv.set_item_photo($1::uuid, $2)', [
          onions,
          key(ids.tenant(), onions),
        ]);
        expect(r.error, u).toMatch(/NOT_AUTHORISED/);
      }
      // nobody writes the item directly: no update policy for app_rw
      const direct = await attemptAs(
        c,
        ids.user('test.executive-chef.1.0'),
        `update inv.item set photo_key = $2 where id = $1`,
        [onions, key(ids.tenant(), onions)],
      );
      expect(direct.error ?? 'no rows').toBeTruthy();
      const still = await c.query<{ photo_key: string | null }>(
        'select photo_key from inv.item where id = $1',
        [onions],
      );
      expect(still.rows[0]!.photo_key).toBeNull();
    });
  });

  it('never across companies, and only the item’s own key', async () => {
    await inRolledBackTx(async (c) => {
      const chef = ids.user('test.executive-chef.1.0');
      // another company's item: as if it did not exist
      const other = await attemptAs(c, chef, 'select inv.set_item_photo($1::uuid, $2)', [
        soloItem,
        key(ids.tenant('TEST-SOLO-COMPANY'), soloItem),
      ]);
      expect(other.error).toMatch(/NOT_AUTHORISED/);
      const solo = await attemptAs<{ ok: boolean }>(
        c,
        ids.user('test.solo.bar-manager'),
        'select inv.can_set_item_photo($1::uuid) as ok',
        [onions],
      );
      expect(solo.rows?.[0]?.ok).toBe(false);
      // keys under another company, another item, another folder or type are refused
      for (const bad of [
        key(ids.tenant('TEST-SOLO-COMPANY'), onions),
        key(ids.tenant(), soloItem),
        `wastage/${ids.tenant()}/${onions}/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jpg`,
        key(ids.tenant(), onions, 'gif'),
        `${key(ids.tenant(), onions)}/../x.jpg`,
      ]) {
        const r = await attemptAs(c, chef, 'select inv.set_item_photo($1::uuid, $2)', [
          onions,
          bad,
        ]);
        expect(r.error, bad).toMatch(/INVALID_PHOTO/);
      }
    });
  });
});
