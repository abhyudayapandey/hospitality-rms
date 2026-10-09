import { TASK_ICONS } from '@outlet-ops/domain';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  migratorPool,
  type SeedIds,
} from '@outlet-ops/db/test-helpers';

// Icons on steps and photos on any task, kept 30 days (GM items 5 and 6, ADR 079). A step's
// icon is one of the product's pictograms (the database's list equals the app's); file 29
// may name one, and a round's copy keeps it. Whoever may work a task adds up to three photos
// of its place while it is to do; whoever sees the task sees them. The nightly purge clears
// routine task and step photos after 30 days and nothing else: kept readings, maintenance,
// bills, compliance documents and selfies stay.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const COMMIS = 'test.commis.1.0';

async function openingTask(c: PoolClient): Promise<{ id: string; tenant: string; node: string }> {
  const r = await c.query<{ id: string; tenant_id: string; org_node_id: string }>(
    `select t.id, t.tenant_id, t.org_node_id from ops.task t
       join ops.checklist_template c on c.id = t.template_id
      where c.code = 'HOTEL-1.0-KITCHEN-OPENING' and t.status in ('open', 'in_progress')
      order by t.due_at limit 1`,
  );
  const t = r.rows[0]!;
  return { id: t.id, tenant: t.tenant_id, node: t.org_node_id };
}

const photo = (tenant: string, node: string, n = 0, prefix = 'routine') =>
  `tasks/${prefix}/${tenant}/${node}/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5${n}.jpg`;

describe('step icons (item 5)', () => {
  it("the database's pictograms are the app's", async () => {
    const r = await migratorPool.query<{ names: string[] }>(
      'select ops.task_icon_names() as names',
    );
    expect(r.rows[0]!.names).toEqual([...TASK_ICONS]);
  });

  it("file 29's step icon reaches the checklist and every round's copy", async () => {
    const tpl = await migratorPool.query<{ steps: { label: string; icon?: string }[] }>(
      `select steps from ops.checklist_template where code = 'HOTEL-1.0-KITCHEN-OPENING'`,
    );
    expect(tpl.rows[0]!.steps[0]).toMatchObject({
      label: 'Walk-in chiller temperature',
      icon: 'fridge',
    });
    expect(tpl.rows[0]!.steps[1]!.icon).toBeUndefined();
    const steps = await migratorPool.query<{ label: string; icon: string | null }>(
      `select s.label, s.icon from ops.task_step s join ops.task t on t.id = s.task_id
         join ops.checklist_template c on c.id = t.template_id
        where c.code = 'HOTEL-1.0-KITCHEN-OPENING' and s.position <= 2
        order by t.due_at, s.position limit 2`,
    );
    expect(steps.rows).toEqual([
      { label: 'Walk-in chiller temperature', icon: 'fridge' },
      { label: 'Hand-wash station stocked', icon: null },
    ]);
  });

  it('an icon that is not one of the pictograms is refused, in a step or the table', async () => {
    await inRolledBackTx(async (c) => {
      await c.query('savepoint a');
      await expect(
        c.query(`select ops.check_steps('[{"label":"Mop","kind":"tick","icon":"rocket"}]')`),
      ).rejects.toThrow(/INVALID_STEPS/);
      await c.query('rollback to savepoint a');
      await c.query(`select ops.check_steps('[{"label":"Mop","kind":"tick","icon":"mop"}]')`);
      await expect(
        c.query(
          `update ops.task_step set icon = 'rocket' where id = (select id from ops.task_step limit 1)`,
        ),
      ).rejects.toThrow(/task_step_icon/);
    });
  });
});

describe('photos on a task (item 6)', () => {
  it('whoever may work it adds up to three; the GM sees them; others see none', async () => {
    await inRolledBackTx(async (c) => {
      const t = await openingTask(c);
      const commis = ids.user(COMMIS);
      for (const n of [1, 2, 3]) {
        const r = await attemptAs(c, commis, 'select ops.add_task_photo($1, $2)', [
          t.id,
          photo(t.tenant, t.node, n),
        ]);
        expect(r.error, String(n)).toBeUndefined();
      }
      const fourth = await attemptAs(c, commis, 'select ops.add_task_photo($1, $2)', [
        t.id,
        photo(t.tenant, t.node, 4),
      ]);
      expect(fourth.error).toMatch(/TOO_MANY_PHOTOS/);
      const gm = await attemptAs<{ photo_key: string; taken_by_name: string }>(
        c,
        ids.user('test.general-manager.1.0'),
        'select photo_key, taken_by_name from ops.task_photos($1)',
        [t.id],
      );
      expect(gm.error).toBeUndefined();
      expect(gm.rows?.length).toBe(3);
      for (const who of ['test.room-attendant.1.0', 'test.solo.bar-manager']) {
        const r = await attemptAs(c, ids.user(who), 'select * from ops.task_photos($1)', [t.id]);
        expect(r.error, who).toMatch(/NOT_AUTHORISED/);
        const direct = await attemptAs(
          c,
          ids.user(who),
          'select id from ops.task_photo where task_id = $1',
          [t.id],
        );
        expect(direct.rows?.length ?? 0, who).toBe(0);
      }
      // audited (rule 5)
      const audit = await c.query(
        `select 1 from audit.log where table_name = 'ops.task_photo' and actor_id = $1`,
        [commis],
      );
      expect(audit.rowCount).toBe(3);
    });
  });

  it('someone who may not work it, a key of another place or prefix, is refused', async () => {
    await inRolledBackTx(async (c) => {
      const t = await openingTask(c);
      const attendant = await attemptAs(
        c,
        ids.user('test.room-attendant.1.0'),
        'select ops.add_task_photo($1, $2)',
        [t.id, photo(t.tenant, t.node)],
      );
      expect(attendant.error).toMatch(/NOT_AUTHORISED/);
      const other = await attemptAs(
        c,
        ids.user('test.solo.bar-manager'),
        'select ops.add_task_photo($1, $2)',
        [t.id, photo(t.tenant, t.node)],
      );
      expect(other.error).toMatch(/NOT_FOUND|NOT_AUTHORISED/);
      for (const bad of [
        photo(t.tenant, ids.node('TEST-HOTEL-1.1-KITCHEN')),
        photo(t.tenant, t.node, 0, 'keep'),
        `bills/${t.tenant}/${t.node}/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a50.jpg`,
      ]) {
        const r = await attemptAs(c, ids.user(COMMIS), 'select ops.add_task_photo($1, $2)', [
          t.id,
          bad,
        ]);
        expect(r.error, bad).toMatch(/INVALID_PHOTO/);
      }
      const direct = await attemptAs(
        c,
        ids.user(COMMIS),
        `insert into ops.task_photo (tenant_id, task_id, org_node_id, photo_key, taken_by)
         values ($1, $2, $3, $4, $5)`,
        [t.tenant, t.id, t.node, photo(t.tenant, t.node), ids.user(COMMIS)],
      );
      expect(direct.error).toMatch(/permission denied/);
    });
  });
});

describe('kept 30 days', () => {
  it('the purge clears routine task and step photos older than 30 days, and nothing else', async () => {
    await inRolledBackTx(async (c) => {
      const t = await openingTask(c);
      const old = "now() - interval '31 days'";
      // a task photo and a step photo from 31 days ago; a kept (flagged) reading's; a new one
      await c.query(
        `insert into ops.task_photo (tenant_id, task_id, org_node_id, photo_key, taken_by, taken_at)
         values ($1, $2, $3, $4, $5, ${old}), ($1, $2, $3, $6, $5, now())`,
        [
          t.tenant,
          t.id,
          t.node,
          photo(t.tenant, t.node, 1),
          ids.user(COMMIS),
          photo(t.tenant, t.node, 2),
        ],
      );
      const steps = await c.query<{ id: string }>(
        'select id from ops.task_step where task_id = $1 order by position limit 2',
        [t.id],
      );
      await c.query(`update ops.task_step set photo_key = $2, done_at = ${old} where id = $1`, [
        steps.rows[0]!.id,
        photo(t.tenant, t.node, 3),
      ]);
      await c.query(`update ops.task_step set photo_key = $2, done_at = ${old} where id = $1`, [
        steps.rows[1]!.id,
        photo(t.tenant, t.node, 4, 'keep'),
      ]);
      const before = await c.query<{ bills: number; selfies: number; licences: number; m: number }>(
        `select (select sum(cardinality(files)) from inv.bill)::int as bills,
                (select count(*) from hr.attendance_selfie where selfie_key is not null)::int as selfies,
                (select count(*) from ops.licence)::int as licences,
                (select count(*) from ops.maintenance_request where photo_key is not null)::int as m`,
      );
      await c.query('set local role wf_executor');
      const n = await c.query<{ n: number }>('select ops.purge_task_photos() as n');
      await c.query('reset role');
      expect(n.rows[0]!.n).toBe(2);
      const photos = await c.query<{ photo_key: string | null; purged: boolean }>(
        `select photo_key, purged_at is not null as purged from ops.task_photo
          where task_id = $1 order by taken_at`,
        [t.id],
      );
      expect(photos.rows).toEqual([
        { photo_key: null, purged: true },
        { photo_key: photo(t.tenant, t.node, 2), purged: false },
      ]);
      const s = await c.query<{ photo_key: string | null }>(
        'select photo_key from ops.task_step where id = any($1) order by position',
        [steps.rows.map((r) => r.id)],
      );
      expect(s.rows.map((r) => r.photo_key)).toEqual([null, photo(t.tenant, t.node, 4, 'keep')]);
      const after = await c.query(
        `select (select sum(cardinality(files)) from inv.bill)::int as bills,
                (select count(*) from hr.attendance_selfie where selfie_key is not null)::int as selfies,
                (select count(*) from ops.licence)::int as licences,
                (select count(*) from ops.maintenance_request where photo_key is not null)::int as m`,
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    });
  });

  it('only the nightly job may purge', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        'select ops.purge_task_photos()',
      );
      expect(r.error).toMatch(/permission denied/);
    });
  });
});
