import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Registers (ADR 090): one engine, a register per kind; who keeps each (file 45), entries
// written and closed, never edited; the required fields; nothing while the block is off.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const SECURITY = 'TEST-HOTEL-1.0-SECURITY';
const FRONT = 'TEST-HOTEL-1.0-FRONT-OFFICE';

async function run<T extends object = Record<string, unknown>>(
  c: PoolClient,
  who: string,
  sql: string,
  params: unknown[] = [],
) {
  const r = await attemptAs<T>(c, ids.user(who), sql, params);
  if (r.error) throw new Error(`${who}: ${r.error}`);
  return r.rows!;
}

const add = (c: PoolClient, who: string, place: string, register: string, fields: object) =>
  attemptAs<{ id: string }>(
    c,
    ids.user(who),
    `select ops.add_register_entry($1, $2, $3::jsonb) as id`,
    [ids.node(place), register, JSON.stringify(fields)],
  );

describe('registers', () => {
  it('a guard logs a visitor in and out; the entry stays, closed', async () => {
    await inRolledBackTx(async (c) => {
      const r = await add(c, 'test.security-guard.1.0', SECURITY, 'visitors', {
        name: 'R. Mehta',
        company: 'Otis lifts',
        visiting: 'Chief engineer',
        junk: 7,
      });
      expect(r.error).toBeUndefined();
      const id = r.rows![0]!.id;
      const [open] = await run<{ status: string; fields: object; can_close: boolean }>(
        c,
        'test.security-guard.1.0',
        `select status, fields, can_close from ops.register_entries($1, 'visitors')`,
        [ids.node(SECURITY)],
      );
      // text fields only
      expect(open).toEqual({
        status: 'open',
        fields: { name: 'R. Mehta', company: 'Otis lifts', visiting: 'Chief engineer' },
        can_close: true,
      });
      await run(c, 'test.security-guard.1.0', `select ops.close_register_entry($1, null, null)`, [
        id,
      ]);
      const again = await attemptAs(
        c,
        ids.user('test.security-guard.1.0'),
        `select ops.close_register_entry($1, null, null)`,
        [id],
      );
      expect(again.error).toMatch(/INVALID_STATE/);
      const [closed] = await run<{ status: string; closed_by: string }>(
        c,
        'test.security-supervisor.1.0',
        `select status, closed_by from ops.register_entries($1, 'visitors')`,
        [ids.node(SECURITY)],
      );
      expect(closed).toEqual({ status: 'closed', closed_by: 'Test Security Guard 1.0' });
      // never edited or deleted by anyone in the app
      const edit = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        `update ops.register_entry set fields = '{}' where id = $1`,
        [id],
      );
      expect(edit.error).toMatch(/permission denied/);
    });
  });

  it('lost and found: returned needs to whom; the outcome is one of three', async () => {
    await inRolledBackTx(async (c) => {
      const r = await add(c, 'test.front-desk-executive.1.0', FRONT, 'lost_found', {
        item: 'Black wallet',
        found_where: 'Room 102',
      });
      const id = r.rows![0]!.id;
      const close = (outcome: string | null, note: string | null) =>
        attemptAs(
          c,
          ids.user('test.front-desk-executive.1.0'),
          `select ops.close_register_entry($1, $2, $3)`,
          [id, outcome, note],
        );
      expect((await close('Kept', null)).error).toMatch(/INVALID_VALUE/);
      expect((await close('Returned to the owner', ' ')).error).toMatch(/INVALID_VALUE/);
      expect(
        (await close('Returned to the owner', 'Guest of 102, passport seen')).error,
      ).toBeUndefined();
    });
  });

  it('the required fields; fire equipment checks are closed when written', async () => {
    await inRolledBackTx(async (c) => {
      expect(
        (await add(c, 'test.security-guard.1.0', SECURITY, 'keys', { key: 'Store 2' })).error,
      ).toMatch(/INVALID_VALUE/);
      const fire = await add(c, 'test.security-supervisor.1.0', SECURITY, 'fire_equipment', {
        equipment: 'CO2 extinguisher 3',
        condition: 'In order',
      });
      expect(fire.error).toBeUndefined();
      const [e] = await run<{ status: string }>(
        c,
        'test.security-supervisor.1.0',
        `select status from ops.register_entries($1, 'fire_equipment')`,
        [ids.node(SECURITY)],
      );
      expect(e!.status).toBe('closed');
    });
  });

  it('kept only by its roles (file 45), those who run a department, and where they work', async () => {
    await inRolledBackTx(async (c) => {
      // visitors: security guards and supervisors; not the front desk, even at the gate
      expect(
        (await add(c, 'test.front-desk-executive.1.0', FRONT, 'visitors', { name: 'x' })).error,
      ).toMatch(/NOT_AUTHORISED/);
      // incidents: anyone who keeps registers where they work
      expect(
        (
          await add(c, 'test.steward.1.0', 'TEST-HOTEL-1.0-RESTAURANT', 'incidents', {
            what_happened: 'Spill',
          })
        ).error,
      ).toBeUndefined();
      // not at another department
      expect(
        (await add(c, 'test.steward.1.0', SECURITY, 'incidents', { what_happened: 'x' })).error,
      ).toMatch(/NOT_AUTHORISED/);
      // the head of a department keeps every register there
      expect(
        (await add(c, 'test.front-office-manager.1.0', FRONT, 'visitors', { name: 'Auditor' }))
          .error,
      ).toBeUndefined();
      const places = await run<{ place: string; registers: string[]; can_write: string[] }>(
        c,
        'test.security-guard.1.0',
        `select place, registers, can_write from ops.register_places()`,
      );
      expect(places).toHaveLength(1);
      expect(places[0]!.can_write).toEqual(
        expect.arrayContaining(['visitors', 'vehicles', 'staff_movement', 'keys', 'lost_found']),
      );
      expect(places[0]!.can_write).not.toContain('fire_equipment');
    });
  });

  it('off at the solo bar except its two; another customer finds nothing; nothing while the block is off', async () => {
    await inRolledBackTx(async (c) => {
      const solo = await run<{ registers: string[] }>(
        c,
        'test.solo.bar-manager',
        `select registers from ops.register_places()`,
      );
      expect([...new Set(solo.flatMap((p) => p.registers))].sort()).toEqual([
        'incidents',
        'lost_found',
      ]);
      const r = await add(c, 'test.security-guard.1.0', SECURITY, 'vehicles', {
        number: 'MH01AB1234',
      });
      const other = await attemptAs(
        c,
        ids.user('test.solo.bar-manager'),
        `select ops.close_register_entry($1, null, null)`,
        [r.rows![0]!.id],
      );
      expect(other.error).toMatch(/NOT_FOUND/);
      await c.query(
        `update core.tenant set settings = jsonb_set(settings, '{modules}',
           coalesce(settings -> 'modules', '{}') || '{"registers": false}') where id = $1`,
        [ids.tenant()],
      );
      expect(
        (await add(c, 'test.security-guard.1.0', SECURITY, 'vehicles', { number: 'x' })).error,
      ).toMatch(/NOT_AUTHORISED/);
      expect(
        await run(c, 'test.security-guard.1.0', `select * from ops.register_places()`),
      ).toEqual([]);
    });
  });
});
