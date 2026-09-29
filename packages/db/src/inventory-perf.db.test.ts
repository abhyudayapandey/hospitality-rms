import { afterAll, describe, expect, it } from 'vitest';
import { closePools, inRolledBackTx } from '../test/helpers';

// ADR 007 regression guard: with 10,000 ledger rows, the worst query before the fix
// (latest 50 movements across every visible node, 1.2-1.5 s with core.can() per row) must
// stay far below 200 ms. The bound here is 500 ms so a slow CI runner cannot flake it;
// the per-row regression it guards against is 3x that. See perf:inventory for the table.

afterAll(closePools);

const USERS = {
  Kim: '01920000-0000-7000-8000-000000000303',
  Aria: '01920000-0000-7000-8000-000000000305', // derived view
};

describe('inventory read performance (ADR 007)', () => {
  it('reads the latest ledger rows across all visible nodes well under the target', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                       unit_cost, ref_type, occurred_at)
         select n.tenant_id, n.item_id, n.delivery_node_id, 'receipt', 1, 10, 'perf-test',
                now() - make_interval(mins => g)
           from generate_series(1, 10000) g
           join lateral (select * from inv.item_node order by item_id, delivery_node_id
                          offset (g % (select count(*) from inv.item_node)) limit 1) n on true`,
      );
      await c.query('analyze inv.stock_ledger');
      for (const [who, uid] of Object.entries(USERS)) {
        await c.query('savepoint q');
        await c.query('set local role app_rw');
        await c.query(`select set_config('app.user_id', $1, true)`, [uid]);
        const sql = `select id, delivery_node_id, occurred_at, qty from inv.stock_ledger
                      order by occurred_at desc limit 50`;
        await c.query(sql);
        const { rows } = await c.query<{
          'QUERY PLAN': { 'Execution Time': number; Plan: unknown }[];
        }>(`explain (analyze, format json) ${sql}`);
        await c.query('rollback to savepoint q');
        const plan = rows[0]!['QUERY PLAN'][0]!;
        expect(plan['Execution Time'], who).toBeLessThan(500);
        expect(JSON.stringify(plan.Plan), who).toContain('InitPlan'); // node set computed once
      }
    });
  }, 60_000);
});
