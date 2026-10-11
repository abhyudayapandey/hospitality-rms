import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asPlatform,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  newPlatformAdmin,
  type SeedIds,
} from '../test/helpers';

// Today's briefing note (ADR 070). Written at a department by whoever holds the duty "Writes
// the shift briefing" (BRIEFING_WRITER: the heads of kitchen and service departments), at
// the outlet or any of its departments by its managers (OUTLET_MANAGER), and by a person
// covering a writer (ADR 061). Read on Home by everyone who works at the outlet, for the
// business day (04:00 cut in the outlet's time zone), the whole day or this part of it.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const BAR = 'TEST-BAR-3.0';

interface Note {
  id: string;
  place: string;
  part: string;
  body: string;
  off_dishes: { id: string; name: string }[];
  written_by: string;
  can_edit: boolean;
}

const save = (
  c: PoolClient,
  who: string,
  place: string,
  part: string,
  body: string,
  dishes: string[] = [],
  key: string | null = null,
) =>
  attemptAs<{ id: string }>(c, ids.user(who), 'select ops.save_briefing($1, $2, $3, $4, $5) id', [
    ids.node(place),
    part,
    body,
    dishes,
    key,
  ]);

async function home(c: PoolClient, who: string): Promise<Note[]> {
  const r = await attemptAs<Note>(c, ids.user(who), 'select * from ops.my_briefing()');
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows;
}

async function dish(c: PoolClient, outlet: string, on: boolean): Promise<string> {
  const r = await c.query<{ id: string }>(
    `select mi.id from menu.menu_item mi
      where mi.tenant_id = $2 and mi.archived_at is null
        and ${on ? '' : 'not'} exists (
          select 1 from menu.menu_outlet mo
           where mo.menu_item_id = mi.id and mo.org_node_id = $1
             and mo.effective_from <= rpt.today($1)
             and (mo.effective_to is null or mo.effective_to >= rpt.today($1)))
      order by mi.name limit 1`,
    [ids.node(outlet), ids.tenant()],
  );
  return r.rows[0]!.id;
}

describe('who writes it', () => {
  it('the heads of kitchen and service departments, at their department', async () => {
    await inRolledBackTx(async (c) => {
      expect(
        (await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, 'day', 'Fish special')).error,
      ).toBeUndefined();
      expect(
        (await save(c, 'test.floor-manager.3.0', `${BAR}-FLOOR-SERVICE`, 'dinner', 'VIP table 4'))
          .error,
      ).toBeUndefined();
      expect(
        (await save(c, 'test.executive-chef.1.0', 'TEST-HOTEL-1.0-KITCHEN', 'lunch', 'No prawns'))
          .error,
      ).toBeUndefined();
      // not at another department
      expect(
        (await save(c, 'test.head-cook.3.0', `${BAR}-FLOOR-SERVICE`, 'day', 'x')).error,
      ).toMatch(/NOT_AUTHORISED/);
    });
  });

  it("the outlet's managers, at the outlet and its departments", async () => {
    await inRolledBackTx(async (c) => {
      expect((await save(c, 'test.bar-manager.3.0', BAR, 'day', 'Target 2 lakh')).error).toBe(
        undefined,
      );
      expect(
        (await save(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.0', 'day', 'Wedding at 7')).error,
      ).toBeUndefined();
      expect(
        (await save(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.0-RESTAURANT', 'day', 'x')).error,
      ).toBeUndefined();
    });
  });

  it('nobody else: staff, leads, other departments, other outlets, other customers', async () => {
    await inRolledBackTx(async (c) => {
      for (const [who, place] of [
        ['test.cook.3.0', `${BAR}-KITCHEN`],
        ['test.server.3.0', `${BAR}-FLOOR-SERVICE`],
        ['test.head-bartender.3.0', `${BAR}-BAR`],
        ['test.executive-housekeeper.1.0', 'TEST-HOTEL-1.0-HOUSEKEEPING'],
        ['test.head-cook.3.0', 'TEST-HOTEL-1.0-KITCHEN'],
        ['test.general-manager.1.0', BAR],
        ['test.account-owner', BAR],
        ['test.area-manager', BAR],
        ['test.solo.head-cook', `${BAR}-KITCHEN`],
      ] as const) {
        expect((await save(c, who, place, 'day', 'x')).error, `${who} at ${place}`).toMatch(
          /NOT_AUTHORISED/,
        );
      }
      // a store is not a place for a note
      expect(
        (await save(c, 'test.bar-manager.3.0', `${BAR}-KITCHEN-STORE`, 'day', 'x')).error,
      ).toMatch(/NOT_AUTHORISED/);
      const { rows } = await c.query(`select 1 from ops.briefing`);
      expect(rows).toEqual([]);
    });
  });

  it('a platform admin cannot write or read one', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const w = await asPlatform(c, admin, 'select ops.save_briefing($1, $2, $3, $4, null)', [
        ids.node(BAR),
        'day',
        'x',
        [],
      ]);
      expect(w.error).toMatch(/NOT_AUTHORISED|permission denied/);
      const r = await asPlatform(c, admin, 'select * from ops.briefing_today($1)', [ids.node(BAR)]);
      expect(r.error).toMatch(/NOT_AUTHORISED|permission denied/);
    });
  });

  it('a person covering a writer writes too (ADR 061)', async () => {
    await inRolledBackTx(async (c) => {
      const gh = 'TEST-GUEST-HOUSE-2.0';
      expect((await save(c, 'test.cook.2.0', gh, 'day', 'x')).error).toMatch(/NOT_AUTHORISED/);
      const cover = await attemptAs(
        c,
        ids.user('test.account-owner'),
        `select core.set_role_cover($1, 'HEAD_COOK', 'covered_by', 'COOK')`,
        [ids.node(gh)],
      );
      expect(cover.error).toBeUndefined();
      expect((await save(c, 'test.cook.2.0', gh, 'day', 'Dal of the day')).error).toBeUndefined();
      expect((await home(c, 'test.room-attendant.2.0')).map((n) => n.body)).toEqual([
        'Dal of the day',
      ]);
    });
  });
});

describe('what it holds', () => {
  it('dishes that are off must be on the outlet menu today', async () => {
    await inRolledBackTx(async (c) => {
      const on = await dish(c, BAR, true);
      const off = await dish(c, BAR, false);
      const ok = await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, 'day', '', [on, on]);
      expect(ok.error).toBeUndefined();
      const { rows } = await c.query<{ off_dishes: string[] }>(
        `select off_dishes from ops.briefing where id = $1`,
        [ok.rows![0]!.id],
      );
      expect(rows[0]!.off_dishes).toEqual([on]);
      expect(
        (await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, 'lunch', 'x', [off])).error,
      ).toMatch(/NOT_ON_MENU/);
      expect((await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, 'lunch', '  ')).error).toMatch(
        /BRIEFING_EMPTY/,
      );
      expect(
        (await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, 'lunch', 'x'.repeat(1001))).error,
      ).toMatch(/BRIEFING_TOO_LONG/);
      expect((await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, 'brunch', 'x')).error).toMatch(
        /INVALID_SUBJECT/,
      );
    });
  });

  it('one note per place, day and part: saving again edits it; a key makes it idempotent', async () => {
    await inRolledBackTx(async (c) => {
      const a = await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, 'day', 'one', [], 'k1');
      const again = await save(
        c,
        'test.head-cook.3.0',
        `${BAR}-KITCHEN`,
        'day',
        'ignored',
        [],
        'k1',
      );
      expect(again.rows![0]!.id).toBe(a.rows![0]!.id);
      // the GM edits the same note at the kitchen
      const b = await save(c, 'test.bar-manager.3.0', `${BAR}-KITCHEN`, 'day', 'two');
      expect(b.rows![0]!.id).toBe(a.rows![0]!.id);
      const { rows } = await c.query(`select body, part from ops.briefing`);
      expect(rows).toEqual([{ body: 'two', part: 'day' }]);
    });
  });

  it('is audited, and taking it down archives it', async () => {
    await inRolledBackTx(async (c) => {
      const a = await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, 'day', 'one');
      const id = a.rows![0]!.id;
      await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, 'day', 'two');
      expect(
        (await attemptAs(c, ids.user('test.cook.3.0'), 'select ops.take_down_briefing($1)', [id]))
          .error,
      ).toMatch(/NOT_AUTHORISED/);
      expect(
        (
          await attemptAs(c, ids.user('test.head-cook.3.0'), 'select ops.take_down_briefing($1)', [
            id,
          ])
        ).error,
      ).toBeUndefined();
      expect(await home(c, 'test.server.3.0')).toEqual([]);
      const { rows } = await c.query<{ action: string }>(
        `select op as action from audit.log where table_name = 'ops.briefing' and row_id = $1
          order by occurred_at, id`,
        [id],
      );
      expect(rows.map((r) => r.action)).toEqual(['INSERT', 'UPDATE', 'UPDATE']);
      const left = await c.query(`select archived_at is not null as gone from ops.briefing`);
      expect(left.rows).toEqual([{ gone: true }]);
    });
  });
});

describe('who reads it', () => {
  it('everyone who works at the outlet, whatever their department; no one elsewhere', async () => {
    await inRolledBackTx(async (c) => {
      const on = await dish(c, BAR, true);
      await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, 'day', 'Fish special', [on]);
      await save(c, 'test.bar-manager.3.0', BAR, 'day', 'Target 2 lakh');
      for (const who of [
        'test.server.3.0',
        'test.cook.3.0',
        'test.bartender.3.0',
        'test.security-guard.3.0',
        'test.cashier.3.0',
        'test.head-cook.3.0',
      ]) {
        const notes = await home(c, who);
        // the outlet's own note first, then the departments
        expect(
          notes.map((n) => [n.place, n.body]),
          who,
        ).toEqual([
          ['Test Bar 3.0', 'Target 2 lakh'],
          ['Test Bar 3.0 – Kitchen', 'Fish special'],
        ]);
        expect(notes[1]!.off_dishes).toHaveLength(1);
        expect(notes[1]!.written_by).toBe('Test Head Cook 3.0');
      }
      expect((await home(c, 'test.head-cook.3.0')).map((n) => n.can_edit)).toEqual([false, true]);
      expect((await home(c, 'test.bar-manager.3.0')).map((n) => n.can_edit)).toEqual([true, true]);
      for (const who of [
        'test.executive-chef.1.0',
        'test.banquet-server.1.0',
        'test.solo.server',
      ]) {
        expect(await home(c, who), who).toEqual([]);
      }
      const other = await attemptAs(
        c,
        ids.user('test.solo.server'),
        'select * from ops.briefing_today($1)',
        [ids.node(BAR)],
      );
      expect(other.error).toMatch(/NOT_AUTHORISED/);
      const elsewhere = await attemptAs(
        c,
        ids.user('test.cook.2.0'),
        'select * from ops.briefing_today($1)',
        [ids.node(BAR)],
      );
      expect(elsewhere.error).toMatch(/NOT_AUTHORISED/);
      // the table itself is RLS-protected: staff read nothing directly
      const direct = await attemptAs(c, ids.user('test.server.3.0'), 'select * from ops.briefing');
      expect(direct.rows ?? []).toEqual([]);
    });
  });

  it('shows for the business day only: a note from yesterday is gone after the 04:00 cut', async () => {
    await inRolledBackTx(async (c) => {
      await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, 'day', 'Yesterday');
      await c.query(`update ops.briefing set business_day = business_day - 1`);
      expect(await home(c, 'test.server.3.0')).toEqual([]);
      // and the next note today is a new one
      const a = await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, 'day', 'Today');
      expect(a.error).toBeUndefined();
      expect((await home(c, 'test.server.3.0')).map((n) => n.body)).toEqual(['Today']);
    });
  });

  it('breakfast from 04:00, lunch from 11:00, dinner from 16:00, late night from 23:00 (outlet time)', async () => {
    await inRolledBackTx(async (c) => {
      const part = async (local: string) =>
        (
          await c.query<{ p: string }>(
            `select ops.briefing_part_now($1, ($2::timestamp at time zone ops.tz_of($1))) p`,
            [ids.node(BAR), local],
          )
        ).rows[0]!.p;
      // ADR 076: breakfast and late night as well
      expect(await part('2026-10-07 04:00')).toBe('breakfast');
      expect(await part('2026-10-07 10:59')).toBe('breakfast');
      expect(await part('2026-10-07 11:00')).toBe('lunch');
      expect(await part('2026-10-07 15:59')).toBe('lunch');
      expect(await part('2026-10-07 16:00')).toBe('dinner');
      expect(await part('2026-10-07 22:59')).toBe('dinner');
      expect(await part('2026-10-07 23:00')).toBe('late_night');
      expect(await part('2026-10-08 03:59')).toBe('late_night');

      const notes: Record<string, string> = {
        breakfast: 'Breakfast note',
        lunch: 'Lunch note',
        dinner: 'Dinner note',
        late_night: 'Late night note',
      };
      for (const [p, body] of Object.entries(notes)) {
        await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, p, body);
      }
      await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, 'day', 'All day');
      const now = await part(
        (
          await c.query<{ t: string }>(
            `select to_char(now() at time zone ops.tz_of($1), 'YYYY-MM-DD HH24:MI') t`,
            [ids.node(BAR)],
          )
        ).rows[0]!.t,
      );
      expect((await home(c, 'test.server.3.0')).map((n) => n.body)).toEqual([
        'All day',
        notes[now],
      ]);
    });
  });
});

describe('the write screen', () => {
  it('lists where a person may write, the notes there and the dishes on the menu', async () => {
    await inRolledBackTx(async (c) => {
      const places = await attemptAs<{ place: string }>(
        c,
        ids.user('test.head-cook.3.0'),
        'select place from ops.briefing_places()',
      );
      expect(places.rows!.map((p) => p.place)).toEqual(['Test Bar 3.0 – Kitchen']);
      const gm = await attemptAs<{ place: string }>(
        c,
        ids.user('test.bar-manager.3.0'),
        'select place from ops.briefing_places()',
      );
      expect(gm.rows![0]!.place).toBe('Test Bar 3.0');
      expect(gm.rows!.length).toBeGreaterThan(3);
      const staff = await attemptAs(
        c,
        ids.user('test.cook.3.0'),
        'select * from ops.briefing_places()',
      );
      expect(staff.rows).toEqual([]);

      const dishes = await attemptAs<{ id: string }>(
        c,
        ids.user('test.head-cook.3.0'),
        'select * from ops.briefing_dishes($1)',
        [ids.node(`${BAR}-KITCHEN`)],
      );
      expect(dishes.rows!.length).toBeGreaterThan(10);
      expect(dishes.rows!.map((d) => d.id)).toContain(await dish(c, BAR, true));
      for (const fn of ['briefing_dishes', 'briefing_at']) {
        const r = await attemptAs(c, ids.user('test.cook.3.0'), `select * from ops.${fn}($1)`, [
          ids.node(`${BAR}-KITCHEN`),
        ]);
        expect(r.error, fn).toMatch(/NOT_AUTHORISED/);
      }
      await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, 'dinner', 'Dinner');
      await save(c, 'test.head-cook.3.0', `${BAR}-KITCHEN`, 'day', 'Day');
      const at = await attemptAs<{ part: string }>(
        c,
        ids.user('test.head-cook.3.0'),
        'select part from ops.briefing_at($1)',
        [ids.node(`${BAR}-KITCHEN`)],
      );
      expect(at.rows!.map((r) => r.part)).toEqual(['day', 'dinner']);
    });
  });
});

describe("tomorrow's briefing (ADR 112)", () => {
  it("a writer writes tomorrow's in the evening; nobody reads it on Home until tomorrow", async () => {
    await inRolledBackTx(async (c) => {
      const place = ids.node(`${BAR}-KITCHEN`);
      const tomorrow = (
        await c.query<{ d: string }>(`select (rpt.today($1) + 1)::text as d`, [place])
      ).rows[0]!.d;
      const w = await attemptAs<{ id: string }>(
        c,
        ids.user('test.head-cook.3.0'),
        'select ops.save_briefing($1, $2, $3, $4, null, $5) id',
        [place, 'day', 'Fish delivery late tomorrow', [], tomorrow],
      );
      expect(w.error).toBeUndefined();
      const at = await attemptAs<{ body: string }>(
        c,
        ids.user('test.head-cook.3.0'),
        'select body from ops.briefing_at($1, $2)',
        [place, tomorrow],
      );
      expect(at.rows!.map((r) => r.body)).toEqual(['Fish delivery late tomorrow']);
      const today = await attemptAs<{ body: string }>(
        c,
        ids.user('test.head-cook.3.0'),
        'select body from ops.briefing_at($1)',
        [place],
      );
      expect(today.rows!.map((r) => r.body)).not.toContain('Fish delivery late tomorrow');
      expect((await home(c, 'test.cook.3.0')).map((n) => n.body)).not.toContain(
        'Fish delivery late tomorrow',
      );
      // only today or tomorrow
      const later = await attemptAs(
        c,
        ids.user('test.head-cook.3.0'),
        'select ops.save_briefing($1, $2, $3, $4, null, $5::date + 1) id',
        [place, 'day', 'Too far', [], tomorrow],
      );
      expect(later.error).toMatch(/INVALID_VALUE/);
    });
  });
});
