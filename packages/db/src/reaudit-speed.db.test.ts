import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// The re-audit's slow screens (ADR 160): the faster functions give the same answers as the
// ones they replace on those screens.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

describe('Where more of an item comes from (inv.ask_source)', () => {
  it.each([
    ['test.executive-chef.1.0', 'TEST-HOTEL-1.0-KITCHEN-STORE'],
    ['test.bar-manager.3.0', 'TEST-BAR-3.0-BAR-STORE'],
    ['test.bar-manager.3.0', 'TEST-BAR-3.0-KITCHEN-STORE'],
  ])('is what Request from a store says, for every item (%s at %s)', async (who, store) => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs<{ item_id: string; listed: boolean; a: string; b: string }>(
        c,
        ids.user(who),
        `select i.id::text as item_id, a.item_id is not null as listed,
                a.source_id::text as a, inv.ask_source($1, i.id)::text as b
           from inv.item i
           left join inv.ask_items($1) a on a.item_id = i.id
          where i.tenant_id = core.my_tenant()`,
        [ids.node(store)],
      );
      expect(r.error).toBeUndefined();
      expect(r.rows!.filter((x) => x.listed && x.a).length).toBeGreaterThan(0);
      for (const x of r.rows!) expect(x.b).toBe(x.listed ? x.a : null);
    });
  });
});

describe('Late rounds for several departments (ops.late_counts)', () => {
  it('counts each department as ops.late_count does', async () => {
    await inRolledBackTx(async (c) => {
      const depts = (
        await c.query<{ id: string }>(
          `select id::text from core.hierarchy_node
            where tenant_id = $1 and type = 'org' and kind = 'department'`,
          [ids.tenant()],
        )
      ).rows.map((x) => x.id);
      const r = await attemptAs<{ id: string; one: number; many: number | null }>(
        c,
        ids.user('test.general-manager.1.0'),
        `with d as (
           select x as id from unnest($1::uuid[]) x where core.can('TASKS', 'modify', x, null))
         select d.id::text, ops.late_count(d.id, current_date - 7, current_date) as one, m.n as many
           from d
           left join ops.late_counts((select array_agg(id) from d), current_date - 7,
                                     current_date) m on m.node_id = d.id`,
        [depts],
      );
      expect(r.error).toBeUndefined();
      expect(r.rows!.length).toBeGreaterThan(1);
      for (const x of r.rows!) expect(x.many).toBe(x.one);
    });
  });

  it('refuses a place the person may not see', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(
        c,
        ids.user('test.bar-manager.3.0'),
        `select * from ops.late_counts(array[$1]::uuid[], current_date - 7, current_date)`,
        [ids.node('TEST-HOTEL-1.0')],
      );
      expect(r.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});

describe('My tasks (ops.my_tasks), whether I lead a place asked once a place', () => {
  it.each([
    'test.general-manager.1.0',
    'test.executive-chef.1.0',
    'test.bar-manager.3.0',
    'test.server.3.0',
    'test.account-owner',
  ])('lists what ops.in_pool gives %s', async (who) => {
    await inRolledBackTx(async (c) => {
      await c.query(`select set_config('app.user_id', $1, true)`, [ids.user(who)]);
      // the rule before (ADR 075, 148), task by task
      const want = await c.query<{ id: string }>(
        `select t.id::text from ops.task t
          where t.tenant_id = core.my_tenant()
            and ((t.status in ('open', 'in_progress')
                  and (t.assignee_user_id = core.current_user_id()
                       or (t.assignee_user_id is null and ops.in_pool(t, core.current_user_id()))))
                 or (ops.done_lately(t)
                     and (t.assignee_user_id = core.current_user_id()
                          or t.completed_by = core.current_user_id()
                          or (t.assign_mode in ('job_role', 'on_shift')
                              and ops.in_pool(t, core.current_user_id())))))
          order by 1`,
      );
      const got = await c.query<{ id: string }>(`select id::text from ops.my_tasks() order by 1`);
      expect(got.rows).toEqual(want.rows);
    });
  });
});
