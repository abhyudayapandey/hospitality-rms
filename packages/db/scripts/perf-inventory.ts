import { join } from 'node:path';
import pg from 'pg';

// Inventory read-path performance check (ADR 007). Inside ONE rolled-back transaction:
// adds ~10,000 ledger rows over 90 days across the Hub and both outlets (the ledger
// trigger keeps inv.stock_level), ANALYZEs, then EXPLAIN ANALYZEs the screens' queries
// as app_rw acting as Kim, Olivia and Aria. Nothing is committed.
//   pnpm --filter @outlet-ops/db perf:inventory [--rows 10000] [--plans]
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '..', '..', '.env'));
} catch {
  // no .env file; rely on the environment
}
const url = process.env.MIGRATOR_DATABASE_URL;
if (!url) throw new Error('MIGRATOR_DATABASE_URL is not set');
const argRows = process.argv.indexOf('--rows');
const ROWS = argRows > 0 ? Number(process.argv[argRows + 1]) : 10_000;
const PLANS = process.argv.includes('--plans');
// --simulate-fix: swap inv.stock_ledger / inv.stock_level select policies (inside the
// rolled-back transaction) for the ADR 007 candidate: the visible node set computed once
// per query from core.can() per node, instead of core.can() per row.
const SIMULATE_FIX = process.argv.includes('--simulate-fix');
const TARGET_MS = 200;

const USERS = {
  Kim: '01920000-0000-7000-8000-000000000303',
  Olivia: '01920000-0000-7000-8000-000000000304',
  Aria: '01920000-0000-7000-8000-000000000305',
};
const OUTLET_A = '01920000-0000-7000-8000-000000000203';

// The queries the stock and ledger screens run (apps/web/lib/inventory.ts).
const QUERIES: Record<string, string> = {
  'stock list (Outlet A)': `
    select i.id, i.sku, i.name, i.category, i.base_uom, n.par_level,
           coalesce(s.on_hand, 0) as on_hand, s.avg_cost, s.value,
           coalesce(s.on_hand, 0) < n.par_level as below_par
      from inv.item_node n
      join inv.item i on i.id = n.item_id
      left join inv.stock_level s on s.item_id = n.item_id and s.delivery_node_id = n.delivery_node_id
     where n.delivery_node_id = '${OUTLET_A}'
     order by i.category, i.name`,
  'ledger, latest 50 (Outlet A)': `
    select l.id, l.occurred_at, l.movement_type, l.qty, l.unit_cost, l.reason, i.name
      from inv.stock_ledger l
      join inv.item i on i.id = l.item_id
     where l.delivery_node_id = '${OUTLET_A}'
     order by l.occurred_at desc
     limit 50`,
  'item ledger, latest 50 (Outlet A)': `
    select l.id, l.occurred_at, l.movement_type, l.qty, l.unit_cost, l.reason
      from inv.stock_ledger l
     where l.delivery_node_id = '${OUTLET_A}'
       and l.item_id = '01920000-0000-7000-8000-000000000424'
     order by l.occurred_at desc
     limit 50`,
  'stock, all visible nodes': `
    select s.delivery_node_id, i.name, s.on_hand, s.value
      from inv.stock_level s join inv.item i on i.id = s.item_id
     order by s.delivery_node_id, i.name`,
  'ledger, latest 50, all visible nodes': `
    select l.id, l.delivery_node_id, l.occurred_at, l.movement_type, l.qty
      from inv.stock_ledger l
     order by l.occurred_at desc
     limit 50`,
  // Candidate fix (ADR 007): pre-filter to the nodes the user can view, computed once
  // (can() per node, not per row); RLS still applies to the rows that remain.
  'ledger, latest 50, all visible nodes (pre-filtered)': `
    select l.id, l.delivery_node_id, l.occurred_at, l.movement_type, l.qty
      from inv.stock_ledger l
     where l.delivery_node_id = any (array(
             select n.id from core.nodes('delivery') n
              where core.can('STOCK_LEVELS', 'view', null, n.id)))
     order by l.occurred_at desc
     limit 50`,
};

interface Plan {
  'Execution Time': number;
  'Planning Time': number;
  Plan: { 'Actual Rows': number };
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('begin');
  const t0 = Date.now();
  await client.query(
    `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                   unit_cost, ref_type, occurred_at)
     select n.tenant_id, n.item_id, n.delivery_node_id,
            -- receipts first, then two receipts of 2 for every consumption of 1, so
            -- the no-negative-stock rule always holds
            case when g > 1000 and (g / 200) % 3 = 2 then 'consumption' else 'receipt' end,
            case when g > 1000 and (g / 200) % 3 = 2 then -1 else 2 end,
            case when g > 1000 and (g / 200) % 3 = 2 then 0 else 50 + g % 40 end,
            'perf', now() - make_interval(mins => ($1 - g) * 13)
       from generate_series(1, $1) g
       join lateral (select * from inv.item_node
                      order by item_id, delivery_node_id
                      offset (g % (select count(*) from inv.item_node)) limit 1) n on true
      order by g`,
    [ROWS],
  );
  const inserted = await client.query<{ n: string }>('select count(*) as n from inv.stock_ledger');
  console.log(
    `ledger rows now ${inserted.rows[0]!.n} (+${ROWS} in ${((Date.now() - t0) / 1000).toFixed(1)} s)`,
  );
  await client.query(
    'analyze inv.stock_ledger; analyze inv.stock_level; analyze inv.item_node; analyze inv.item',
  );
  if (SIMULATE_FIX) {
    await client.query(`
      create function public.perf_visible_nodes(p_domain text, p_access text) returns uuid[]
      language sql stable security definer set search_path = pg_catalog, core as $$
        select coalesce(array_agg(n.id), '{}') from core.hierarchy_node n
         where n.tenant_id = core.my_tenant() and n.type = 'delivery'
           and core.can(p_domain, p_access, null, n.id) $$;
      grant execute on function public.perf_visible_nodes(text, text) to app_rw;
      drop policy dom_select on inv.stock_ledger;
      create policy dom_select on inv.stock_ledger for select to app_rw
        using (delivery_node_id = any ((select public.perf_visible_nodes('STOCK_LEVELS', 'view'))::uuid[]));
      drop policy dom_select on inv.stock_level;
      create policy dom_select on inv.stock_level for select to app_rw
        using (delivery_node_id = any ((select public.perf_visible_nodes('STOCK_LEVELS', 'view'))::uuid[]));`);
    console.log('simulating the per-query node set policy');
  }

  const results: string[] = [];
  let worst = 0;
  for (const [who, uid] of Object.entries(USERS)) {
    for (const [name, sql] of Object.entries(QUERIES)) {
      await client.query('savepoint q');
      await client.query('set local role app_rw');
      await client.query(`select set_config('app.user_id', $1, true)`, [uid]);
      // warm once, then measure
      await client.query(sql);
      const { rows } = await client.query<{ 'QUERY PLAN': Plan[] }>(
        `explain (analyze, buffers, format json) ${sql}`,
      );
      const plan = rows[0]!['QUERY PLAN'][0]!;
      const ms = plan['Execution Time'] + plan['Planning Time'];
      worst = Math.max(worst, ms);
      results.push(
        `| ${who} | ${name} | ${plan.Plan['Actual Rows']} | ${plan['Planning Time'].toFixed(1)} | ${plan['Execution Time'].toFixed(1)} | ${ms <= TARGET_MS ? 'ok' : 'SLOW'} |`,
      );
      if (PLANS) {
        const text = await client.query<{ 'QUERY PLAN': string }>(`explain (analyze) ${sql}`);
        console.log(`\n--- ${who}: ${name}\n${text.rows.map((r) => r['QUERY PLAN']).join('\n')}`);
      }
      await client.query('rollback to savepoint q');
    }
  }
  console.log('\n| User | Query | Rows | Planning ms | Execution ms | Target 200 ms |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  console.log(results.join('\n'));
  console.log(`\nworst: ${worst.toFixed(1)} ms`);
} finally {
  await client.query('rollback');
  await client.end();
}
