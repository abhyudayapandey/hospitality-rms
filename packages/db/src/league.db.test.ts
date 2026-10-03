import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';
import { as, everyone, placesOf } from '../test/report-access';

// The league table (R-4, ADR 031): the outlets of an area, region or company side by side
// over a period, never one blended figure. It opens at a company, region or area where the
// person reads the outlets' sales there (DERIVED_SALES: the Area Manager) or holds REPORTS
// (the Account Owner), when two or more of its outlets are theirs to open. A row is an
// outlet the person may open Outlet today for; its labour and prime cost show only where
// they may see labour cost, and never for fewer than 3 paid people (ADR 030).

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

interface LeagueRow {
  code: string;
  sales: string;
  food_pct: string | null;
  drink_pct: string | null;
  labour_pct: string | null;
  prime_pct: string | null;
  wastage_pct: string | null;
  tasks_pct: string | null;
}

const LEAGUE = `select n.code, l.sales::text, l.food_pct::text, l.drink_pct::text,
                       l.labour_pct::text, l.prime_pct::text, l.wastage_pct::text,
                       l.tasks_pct::text
                  from rpt.league($1, current_date - $2::int, current_date - $3::int) l
                  join core.hierarchy_node n on n.id = l.outlet_id
                 order by n.code`;

async function league(c: PoolClient, user: string, place: string, from = 7, to = 1) {
  return as<LeagueRow>(c, user, LEAGUE, [ids.node(place), from, to]);
}

async function leagueRows(c: PoolClient, user: string, place: string): Promise<LeagueRow[]> {
  const r = await league(c, user, place);
  if (r.error !== undefined) throw new Error(r.error);
  return r.rows;
}

/** The rule, as an independent check (n = a hierarchy_node). */
const RULE = `n.type = 'org' and n.kind in ('company', 'region', 'area')
  and (core.can('REPORTS', 'view', n.id, null) or core.can('DERIVED_SALES', 'view', n.id, null))
  and (select count(*) from core.hierarchy_node o
        where o.type = 'org' and o.kind = 'outlet' and o.archived_at is null
          and o.path operator(extensions.<@) n.path
          and rpt.can_open('outlet_flash', o.id)) >= 2`;

describe('the league table: who opens it where (every user)', () => {
  it('lists exactly the places that pass the rule', async () => {
    await inRolledBackTx(async (c) => {
      const wrong: string[] = [];
      for (const p of await everyone(c)) {
        const got = await placesOf(c, p.id, 'league');
        await c.query(`select set_config('app.user_id', $1, true)`, [p.id]);
        const { rows } = await c.query<{ code: string }>(
          `select n.code from core.hierarchy_node n
            where n.tenant_id = core.my_tenant() and n.archived_at is null and ${RULE}`,
        );
        await c.query(`select set_config('app.user_id', '', true)`);
        const want = rows.map((r) => r.code).sort();
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          wrong.push(`${p.username}: got [${got.join(', ')}], want [${want.join(', ')}]`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }, 180_000);

  it('expected shapes: the Area Manager at the area, the owner at every level; nobody else', async () => {
    await inRolledBackTx(async (c) => {
      const pl = (u: string) => placesOf(c, ids.user(u), 'league');
      expect(await pl('test.area-manager')).toEqual(['TEST-AREA-MUMBAI']);
      expect(await pl('test.account-owner')).toEqual([
        'TEST-AREA-MUMBAI',
        'TEST-COMPANY',
        'TEST-REGION-WEST',
      ]);
      // one outlet is no league
      expect(await pl('test.solo.bar-manager')).toEqual([]);
      for (const u of [
        'test.general-manager.1.0',
        'test.cost-controller.1.0',
        'test.executive-chef.1.0',
        'test.hr-admin',
        'test.bartender.1.0',
      ]) {
        expect(await pl(u), u).toEqual([]);
      }
    });
  });

  it('refuses a place outside the rule, another company, and a period over 35 days', async () => {
    await inRolledBackTx(async (c) => {
      expect(
        (await league(c, ids.user('test.general-manager.1.0'), 'TEST-AREA-MUMBAI')).error,
      ).toBe('NOT_AUTHORISED');
      // an outlet is not a league
      expect((await league(c, ids.user('test.account-owner'), 'TEST-HOTEL-1.0')).error).toBe(
        'NOT_AUTHORISED',
      );
      expect((await league(c, ids.user('test.account-owner'), 'TEST-SOLO-COMPANY')).error).toBe(
        'NOT_AUTHORISED',
      );
      expect(
        (await league(c, ids.user('test.area-manager'), 'TEST-AREA-MUMBAI', 40, 1)).error,
      ).toBe('INVALID_DATE');
    });
  });
});

describe('the league table: what each row shows', () => {
  it('one row per outlet of the area, the same sales as Outlet today day by day', async () => {
    await inRolledBackTx(async (c) => {
      const am = ids.user('test.area-manager');
      const r = await leagueRows(c, am, 'TEST-AREA-MUMBAI');
      expect(r.map((x) => x.code)).toEqual([
        'TEST-BAR-3.0',
        'TEST-GUEST-HOUSE-2.0',
        'TEST-HOTEL-1.0',
        'TEST-HOTEL-1.1',
      ]);
      // Hotel 1.0's sales are the sum of Outlet today's over the same days
      const flash = await as<{ v: string }>(
        c,
        am,
        `select coalesce(sum(f.value), 0)::text as v
           from generate_series(1, 7) d
           cross join lateral rpt.outlet_flash($1, current_date - d) f
          where f.measure = 'sales'`,
        [ids.node('TEST-HOTEL-1.0')],
      );
      const hotel = r.find((x) => x.code === 'TEST-HOTEL-1.0')!;
      expect(Number(hotel.sales)).toBeCloseTo(Number(flash.rows?.[0]?.v), 2);
      expect(Number(hotel.sales)).toBeGreaterThan(0);
      expect(hotel.food_pct).not.toBeNull();
      expect(hotel.drink_pct).not.toBeNull();
    });
  });

  it('labour and prime cost: the area manager sees them (LABOUR_COST); without it, they are empty', async () => {
    await inRolledBackTx(async (c) => {
      const am = ids.user('test.area-manager');
      const hotel = (await leagueRows(c, am, 'TEST-AREA-MUMBAI')).find(
        (x) => x.code === 'TEST-HOTEL-1.0',
      )!;
      // people cost over days -7..-1 at Hotel 1.0 is ₹4,65,225 (labour-reports.db.test.ts)
      expect(Number(hotel.labour_pct)).toBeCloseTo((465225 * 100) / Number(hotel.sales), 1);
      expect(Number(hotel.prime_pct)).toBeGreaterThan(Number(hotel.labour_pct));

      // the same person without labour cost: the Area Manager group loses LABOUR_COST
      await c.query(
        `delete from core.domain_policy dp
          using core.domain d, core.security_group g
          where d.id = dp.domain_id and d.code = 'LABOUR_COST'
            and g.id = dp.group_id and g.code = 'AREA_MANAGER' and dp.tenant_id = $1`,
        [ids.tenant()],
      );
      const without = await leagueRows(c, am, 'TEST-AREA-MUMBAI');
      expect(without.length).toBe(4);
      expect(without.every((x) => x.labour_pct === null && x.prime_pct === null)).toBe(true);
      expect(without.find((x) => x.code === 'TEST-HOTEL-1.0')!.food_pct).toBe(hotel.food_pct);
    });
  });
});
