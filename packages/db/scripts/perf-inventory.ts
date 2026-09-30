import { join } from 'node:path';
import pg from 'pg';

// Inventory read-path performance check (ADR 007). Inside ONE rolled-back transaction:
// adds ~10,000 ledger rows over 90 days across every stock location of the seeded test
// customers (the ledger trigger keeps inv.stock_level), ANALYZEs, then EXPLAIN ANALYZEs
// the screens' queries as app_rw acting as a store keeper, an outlet manager and an area
// manager of Test Company. Nothing is committed.
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

const TARGET_MS = 200;

/** Test Company users (docs/onboarding/test-data), by username. */
const USERNAMES = {
  'Head Cook 3.0': 'test.head-cook.3.0',
  'Bar Manager 3.0': 'test.bar-manager.3.0',
  'Area Manager': 'test.area-manager',
};
const STORE = 'TEST-BAR-3.0-KITCHEN-STORE';

// The queries the stock and ledger screens run (apps/web/lib/inventory.ts).
const queries = (store: string, item: string): Record<string, string> => ({
  'stock list (one store)': `
    select i.id, i.sku, i.name, i.category, i.base_uom, n.par_level,
           coalesce(s.on_hand, 0) as on_hand, s.avg_cost, s.value,
           coalesce(s.on_hand, 0) < n.par_level as below_par
      from inv.item_node n
      join inv.item i on i.id = n.item_id
      left join inv.stock_level s on s.item_id = n.item_id and s.delivery_node_id = n.delivery_node_id
     where n.delivery_node_id = '${store}'
     order by i.category, i.name`,
  'ledger, latest 50 (one store)': `
    select l.id, l.occurred_at, l.movement_type, l.qty, l.unit_cost, l.reason, i.name
      from inv.stock_ledger l
      join inv.item i on i.id = l.item_id
     where l.delivery_node_id = '${store}'
     order by l.occurred_at desc
     limit 50`,
  'item ledger, latest 50 (one store)': `
    select l.id, l.occurred_at, l.movement_type, l.qty, l.unit_cost, l.reason
      from inv.stock_ledger l
     where l.delivery_node_id = '${store}'
       and l.item_id = '${item}'
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
});

interface Plan {
  'Execution Time': number;
  'Planning Time': number;
  Plan: { 'Actual Rows': number };
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('begin');
  const tenant = `(select id from core.tenant where code = 'TEST-COMPANY')`;
  const users: Record<string, string> = {};
  for (const [label, username] of Object.entries(USERNAMES)) {
    const u = await client.query<{ id: string }>(
      `select id from core.app_user where tenant_id = ${tenant} and username = $1`,
      [username],
    );
    if (!u.rows[0]) throw new Error(`${username} not found (run pnpm db:seed)`);
    users[label] = u.rows[0].id;
  }
  const at = await client.query<{ store: string; item: string }>(
    `select n.delivery_node_id as store, n.item_id as item
       from inv.item_node n join core.hierarchy_node h on h.id = n.delivery_node_id
      where h.tenant_id = ${tenant} and h.code = $1 order by n.item_id limit 1`,
    [STORE],
  );
  if (!at.rows[0]) throw new Error(`${STORE} has no items (run pnpm db:seed)`);
  const QUERIES = queries(at.rows[0].store, at.rows[0].item);
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

  const results: string[] = [];
  let worst = 0;
  for (const [who, uid] of Object.entries(users)) {
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
