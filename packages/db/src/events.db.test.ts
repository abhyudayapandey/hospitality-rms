import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';
import { ensureJobRoles, newWorker, tenantOf } from '../test/workforce';

// Events (ADR 008): org-tree access, requirement lines (items, roles) replaced on edit
// and kept for the AI layer, cancel; plus marking notifications read.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const OLIVIA = () => ids.user('test.bar-manager.3.0');
const upsert = `select ops.upsert_event($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8::jsonb, $9, $10) as id`;

async function items(c: PoolClient): Promise<[string, string]> {
  const tenant = await tenantOf(c, ids);
  await ensureJobRoles(c, tenant);
  const { rows } = await c.query<{ id: string }>(
    `insert into inv.item (tenant_id, sku, name, category, base_uom)
     values ($1, 'EV-1', 'Paneer', 'Dairy', 'kg'), ($1, 'EV-2', 'Rice', 'Dry', 'kg') returning id`,
    [tenant],
  );
  return [rows[0]!.id, rows[1]!.id];
}

function reqs(item1: string, item2: string) {
  return JSON.stringify([
    { kind: 'item', item_id: item1, qty: 12.5 },
    { kind: 'item', item_id: item2, qty: 20 },
    {
      kind: 'role',
      role_code: 'SERVER',
      headcount: 4,
      starts_at: '2026-12-12T12:00:00Z',
      ends_at: '2026-12-12T17:00:00Z',
    },
  ]);
}

const EVENT = (item1: string, item2: string, key: string | null = null) => [
  null,
  ids.node('TEST-BAR-3.0-FLOOR-SERVICE'),
  'Wedding lunch',
  '2026-12-12T13:00:00Z',
  '2026-12-12T16:00:00Z',
  120,
  'Veg only',
  reqs(item1, item2),
  'planned',
  key,
];

describe('ops.upsert_event', () => {
  it('creates an event with item and role requirements; staff and the AI agent can read it', async () => {
    await inRolledBackTx(async (c) => {
      const [i1, i2] = await items(c);
      const r = await attemptAs<{ id: string }>(c, OLIVIA(), upsert, EVENT(i1, i2));
      expect(r.error).toBeUndefined();
      const id = r.rows![0]!.id;
      const read = async (user: string) =>
        (
          await attemptAs<{ kind: string }>(
            c,
            user,
            `select kind from ops.event_requirement where event_id = $1 and archived_at is null order by kind`,
            [id],
          )
        ).rows!.map((x) => x.kind);
      expect(await read(ids.user('test.server.3.0'))).toEqual(['item', 'item', 'role']);
      expect(await read(ids.user('ai-agent'))).toEqual(['item', 'item', 'role']);
      expect(await read(ids.user('test.area-manager'))).toEqual(['item', 'item', 'role']);
      const omar = await newWorker(c, ids, 'Omar B Manager', 'TEST-GUEST-HOUSE-2.0', 'MANAGER', [
        ['OUTLET_MANAGER', 'TEST-GUEST-HOUSE-2.0'],
      ]);
      expect(await read(omar.userId)).toEqual([]);
    });
  });

  it('edits replace requirements (old lines archived) and are idempotent on create', async () => {
    await inRolledBackTx(async (c) => {
      const [i1, i2] = await items(c);
      const a = await attemptAs<{ id: string }>(c, OLIVIA(), upsert, EVENT(i1, i2, 'ev-key'));
      const b = await attemptAs<{ id: string }>(c, OLIVIA(), upsert, EVENT(i1, i2, 'ev-key'));
      const id = a.rows![0]!.id;
      expect(b.rows![0]!.id).toBe(id);
      const edit = EVENT(i1, i2);
      edit[0] = id;
      edit[5] = 150;
      edit[7] = JSON.stringify([{ kind: 'item', item_id: i1, qty: 15 }]);
      edit[8] = 'confirmed';
      expect((await attemptAs(c, OLIVIA(), upsert, edit)).error).toBeUndefined();
      const lines = await c.query<{ active: boolean; n: string }>(
        `select archived_at is null active, count(*) n from ops.event_requirement
          where event_id = $1 group by 1 order by 1`,
        [id],
      );
      expect(lines.rows).toEqual([
        { active: false, n: '3' },
        { active: true, n: '1' },
      ]);
      const ev = await c.query(`select covers, status from ops.event where id = $1`, [id]);
      expect(ev.rows[0]).toEqual({ covers: 150, status: 'confirmed' });
    });
  });

  it('validates requirements, dates and access', async () => {
    await inRolledBackTx(async (c) => {
      const [i1, i2] = await items(c);
      const bad = (patch: (a: unknown[]) => void) => {
        const a = EVENT(i1, i2);
        patch(a);
        return a;
      };
      const err = async (user: string, args: unknown[]) =>
        (await attemptAs(c, user, upsert, args)).error;
      expect(await err(ids.user('test.server.3.0'), EVENT(i1, i2))).toBe('NOT_AUTHORISED');
      expect(await err(ids.user('test.area-manager'), EVENT(i1, i2))).toBe('NOT_AUTHORISED');
      expect(
        await err(
          OLIVIA(),
          bad((a) => (a[1] = ids.node('TEST-GUEST-HOUSE-2.0'))),
        ),
      ).toBe('NOT_AUTHORISED');
      expect(
        await err(
          OLIVIA(),
          bad((a) => (a[4] = '2026-12-12T12:00:00Z')),
        ),
      ).toBe('INVALID_DATES');
      expect(
        await err(
          OLIVIA(),
          bad((a) => (a[7] = JSON.stringify([{ kind: 'item', item_id: i1, qty: 0 }]))),
        ),
      ).toBe('INVALID_ITEM');
      expect(
        await err(
          OLIVIA(),
          bad(
            (a) =>
              (a[7] = JSON.stringify([
                {
                  kind: 'role',
                  role_code: 'PILOT',
                  headcount: 1,
                  starts_at: '2026-12-12T12:00:00Z',
                  ends_at: '2026-12-12T13:00:00Z',
                },
              ])),
          ),
        ),
      ).toBe('INVALID_LINES');
      expect(
        await err(
          OLIVIA(),
          bad(
            (a) =>
              (a[7] = JSON.stringify([
                { kind: 'item', item_id: i1, qty: 1 },
                { kind: 'item', item_id: i1, qty: 2 },
              ])),
          ),
        ),
      ).toBe('INVALID_LINES');
    });
  });

  it('cancel: then no more edits; nobody writes events directly', async () => {
    await inRolledBackTx(async (c) => {
      const [i1, i2] = await items(c);
      const id = (await attemptAs<{ id: string }>(c, OLIVIA(), upsert, EVENT(i1, i2))).rows![0]!.id;
      expect(
        (await attemptAs(c, ids.user('test.server.3.0'), 'select ops.cancel_event($1)', [id]))
          .error,
      ).toBe('NOT_AUTHORISED');
      expect(
        (await attemptAs(c, OLIVIA(), 'select ops.cancel_event($1)', [id])).error,
      ).toBeUndefined();
      const edit = EVENT(i1, i2);
      edit[0] = id;
      expect((await attemptAs(c, OLIVIA(), upsert, edit)).error).toBe('INVALID_STATE');
      expect(
        (await attemptAs(c, OLIVIA(), `update ops.event set covers = 1 where id = $1`, [id])).error,
      ).toMatch(/permission denied/);
    });
  });
});

describe('ops.mark_read', () => {
  it('marks only the caller’s notifications read', async () => {
    await inRolledBackTx(async (c) => {
      const tenant = await tenantOf(c, ids);
      await c.query('delete from ops.notification'); // e2e residue
      await c.query(`select ops.notify($1, $2, 'test', 'a')`, [
        tenant,
        ids.user('test.server.3.0'),
      ]);
      await c.query(`select ops.notify($1, $2, 'test', 'b')`, [
        tenant,
        ids.user('test.server.3.0'),
      ]);
      await c.query(`select ops.notify($1, $2, 'test', 'c')`, [tenant, ids.user('test.cook.3.0')]);
      const n = await attemptAs<{ n: number }>(
        c,
        ids.user('test.server.3.0'),
        'select ops.mark_read() n',
      );
      expect(n.rows![0]!.n).toBe(2);
      const casey = await c.query(
        `select read_at from ops.notification where owner_user_id = $1 and kind = 'test'`,
        [ids.user('test.cook.3.0')],
      );
      expect(casey.rows[0]).toEqual({ read_at: null });
    });
  });
});
