import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Pickers list only who can do the job (ADR 151): Give rooms, Give sections and handing a
// licence's renewal on.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

describe('who can do the job', () => {
  it("Give rooms lists the roles that do the outlet's room rounds", async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs<{ role_name: string; name: string }>(
        c,
        ids.user('test.executive-housekeeper.1.0'),
        'select * from ops.room_people($1)',
        [ids.node('TEST-HOTEL-1.0')],
      );
      expect(r.error).toBeUndefined();
      expect(r.rows!.map((x) => x.name).sort()).toEqual([
        'Test Room Attendant 1.0',
        'Test Room Attendant B 1.0',
      ]);
    });
  });

  it("Give sections lists the floor's people, not its managers", async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs<{ name: string }>(
        c,
        ids.user('test.restaurant-manager.1.0'),
        'select * from ops.section_people($1)',
        [ids.node('TEST-HOTEL-1.0-RESTAURANT')],
      );
      expect(r.error).toBeUndefined();
      const names = r.rows!.map((x) => x.name);
      expect(names).toContain('Test Captain 1.0');
      expect(names).toContain('Test Steward 1.0');
      expect(names).not.toContain('Test Restaurant Manager 1.0');
    });
  });

  it("a licence's renewal goes to its role, its department or the outlet's managers", async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select id from ops.task where kind = 'licence' and title = 'Renew: FSSAI licence'
           and org_node_id = $1`,
        [ids.node('TEST-HOTEL-1.0')],
      );
      const r = await attemptAs<{ name: string }>(
        c,
        ids.user('test.general-manager.1.0'),
        'select * from ops.hand_on_people($1)',
        [rows[0]!.id],
      );
      expect(r.error).toBeUndefined();
      const names = r.rows!.map((x) => x.name);
      expect(names.length).toBeGreaterThan(0);
      // never the giver (ADR 145)
      expect(names).not.toContain('Test General Manager 1.0');
      // not everyone at the hotel
      expect(names).not.toContain('Test Bartender 1.0');
      expect(names).not.toContain('Test Room Attendant 1.0');
    });
  });
  it("an event asks for staff from the outlet's own roles, at outlets the planner sees", async () => {
    await inRolledBackTx(async (c) => {
      const manager = ids.user('test.bar-manager.3.0');
      const r = await attemptAs<{ code: string; name: string }>(
        c,
        manager,
        'select * from ops.event_roles($1)',
        [ids.node('TEST-BAR-3.0')],
      );
      expect(r.error).toBeUndefined();
      const codes = r.rows!.map((x) => x.code);
      expect(codes).toContain('BARTENDER');
      expect(codes).not.toContain('ROOM_ATTENDANT');
      // at the floor, the kitchen's roles are offered too
      const floor = await attemptAs<{ code: string }>(
        c,
        manager,
        'select * from ops.event_roles($1)',
        [ids.node('TEST-BAR-3.0-FLOOR-SERVICE')],
      );
      expect(floor.rows!.map((x) => x.code).sort()).toEqual([...codes].sort());
      const away = await attemptAs(c, manager, 'select * from ops.event_roles($1)', [
        ids.node('TEST-HOTEL-1.0'),
      ]);
      expect(away.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});
