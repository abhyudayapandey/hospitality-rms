import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';
import { clearWorkforce, workerFor } from '../test/workforce';

// Clock-in device and selfie (ATT-7, ADR 045). The device is a random id kept in the phone's
// browser, with the phone model; a new device (after a person's first week) or one device
// used by several people in a day is flagged on the exceptions screen, never blocking. The
// selfie is taken at clock-in only and a missing camera is flagged, not blocked. Selfies are
// seen by HR and the person's department head (and the person), not the GM or the area
// manager, and are kept as personnel data (NFR Data retention).

const SAM = 'test.server.3.0'; // Floor Service at Test Bar 3.0
const PAT = 'test.server-b.3.0'; // same department
const FLOOR = 'test.floor-manager.3.0'; // head of Floor Service
const OLIVIA = 'test.bar-manager.3.0'; // the GM
const ARIA = 'test.area-manager';
const HARPER = 'test.hr-admin'; // HR
const OTHER_COMPANY = 'test.solo.bar-manager';

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const FLOOR_NODE = 'TEST-BAR-3.0-FLOOR-SERVICE';

async function fixture(c: PoolClient) {
  await clearWorkforce(c);
  const w = {
    sam: await workerFor(c, ids, SAM, FLOOR_NODE, 'SERVER'),
    pat: await workerFor(c, ids, PAT, FLOOR_NODE, 'SERVER'),
  };
  return { ...w, tenant: ids.tenant(), node: ids.node(FLOOR_NODE) };
}

interface Punch {
  attendance_id: string;
  flags: string[];
}

const selfieKey = (f: { tenant: string; node: string }, n = 1) =>
  `selfies/${f.tenant}/${f.node}/00000000-0000-4000-8000-${String(n).padStart(12, '0')}.jpg`;

async function clockIn(
  c: PoolClient,
  who: string,
  key: string,
  opts: {
    device?: string | null;
    model?: string | null;
    selfie?: string | null;
    source?: 'online' | 'offline';
    clientTs?: string | null;
  } = {},
) {
  return attemptAs<Punch>(
    c,
    ids.user(who),
    `select attendance_id, flags
       from hr.clock('in', null, null, null, $1::timestamptz, $2, $3, $4, $5, $6)`,
    [
      opts.clientTs ?? null,
      opts.source ?? 'online',
      key,
      opts.device ?? null,
      opts.model ?? null,
      opts.selfie ?? null,
    ],
  );
}

const clockOut = (c: PoolClient, who: string, key: string) =>
  attemptAs<Punch>(
    c,
    ids.user(who),
    `select attendance_id, flags from hr.clock('out', null, null, null, null, 'online', $1)`,
    [key],
  );

const flagsOf = async (c: PoolClient, attendance: string) =>
  (
    await c.query<{ kind: string }>(
      `select kind from hr.attendance_exception where attendance_id = $1 order by kind`,
      [attendance],
    )
  ).rows.map((r) => r.kind);

describe('device and selfie at clock-in', () => {
  it('records the device, the phone model and the selfie, and flags nothing for a first clock-in', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const r = await clockIn(c, SAM, 'k1', {
        device: 'dev-sam-1',
        model: 'Pixel 7',
        selfie: selfieKey(f),
      });
      expect(r.error).toBeUndefined();
      const p = r.rows![0]!;
      expect(p.flags.filter((x) => x !== 'no_location')).toEqual([]);
      const { rows } = await c.query<{
        in_device_id: string;
        in_device_model: string;
        selfie_key: string;
      }>(
        `select a.in_device_id, a.in_device_model, s.selfie_key
           from hr.attendance a join hr.attendance_selfie s on s.attendance_id = a.id
          where a.id = $1`,
        [p.attendance_id],
      );
      expect(rows[0]).toEqual({
        in_device_id: 'dev-sam-1',
        in_device_model: 'Pixel 7',
        selfie_key: selfieKey(f),
      });
    });
  });

  it('flags a missing camera instead of blocking the clock-in, and needs no selfie to clock out', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      void f;
      const r = await clockIn(c, SAM, 'k1', { device: 'dev-sam-1' });
      expect(r.error).toBeUndefined();
      expect(r.rows![0]!.flags).toContain('no_selfie');
      expect(await flagsOf(c, r.rows![0]!.attendance_id)).toContain('no_selfie');
      expect((await clockOut(c, SAM, 'o1')).error).toBeUndefined();
    });
  });

  it('refuses a selfie that was not uploaded for this person’s place', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      for (const bad of [
        `selfies/${f.tenant}/${ids.node('TEST-BAR-3.0-KITCHEN')}/00000000-0000-4000-8000-000000000001.jpg`,
        'selfies/other/x.jpg',
        `wastage/${f.tenant}/${f.node}/00000000-0000-4000-8000-000000000001.jpg`,
      ]) {
        expect((await clockIn(c, SAM, 'kx', { selfie: bad })).error).toBe('INVALID_PHOTO');
      }
    });
  });

  it('flags a new device only after the first week of use', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      // day 1: the first device; a second one in the first week is a phone change, not flagged
      const a = await clockIn(c, SAM, 'k1', { device: 'dev-a', selfie: selfieKey(f) });
      await clockOut(c, SAM, 'o1');
      const b = await clockIn(c, SAM, 'k2', { device: 'dev-b', selfie: selfieKey(f, 2) });
      expect(await flagsOf(c, b.rows![0]!.attendance_id)).not.toContain('new_device');
      await clockOut(c, SAM, 'o2');
      // a week on: the first device is more than 7 days old; a third one is flagged
      await c.query(
        `update hr.worker_device set first_seen_at = now() - interval '9 days'
                      where worker_id = $1 and device_id = 'dev-a'`,
        [f.sam],
      );
      const d = await clockIn(c, SAM, 'k3', { device: 'dev-c', selfie: selfieKey(f, 3) });
      expect(await flagsOf(c, d.rows![0]!.attendance_id)).toContain('new_device');
      await clockOut(c, SAM, 'o3');
      // a known device is never flagged
      const e = await clockIn(c, SAM, 'k4', { device: 'dev-a', selfie: selfieKey(f, 4) });
      expect(await flagsOf(c, e.rows![0]!.attendance_id)).not.toContain('new_device');
      void a;
    });
  });

  it('flags one device used by two people on the same day, on both punches', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const sam = await clockIn(c, SAM, 'k1', { device: 'shared-1', selfie: selfieKey(f) });
      expect(await flagsOf(c, sam.rows![0]!.attendance_id)).not.toContain('shared_device');
      const pat = await clockIn(c, PAT, 'k2', { device: 'shared-1', selfie: selfieKey(f, 2) });
      expect(await flagsOf(c, pat.rows![0]!.attendance_id)).toContain('shared_device');
      expect(await flagsOf(c, sam.rows![0]!.attendance_id)).toContain('shared_device');
      expect(pat.rows![0]!.flags).toContain('shared_device');
    });
  });

  it('does not flag a device used by two people on different days', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const sam = await clockIn(c, SAM, 'k1', { device: 'shared-2', selfie: selfieKey(f) });
      await c.query(
        `update hr.attendance
            set clock_in_at = clock_in_at - interval '2 days',
                clock_out_at = clock_in_at - interval '2 days' + interval '8 hours',
                out_source = 'online'
          where id = $1`,
        [sam.rows![0]!.attendance_id],
      );
      const pat = await clockIn(c, PAT, 'k2', { device: 'shared-2', selfie: selfieKey(f, 2) });
      expect(await flagsOf(c, pat.rows![0]!.attendance_id)).not.toContain('shared_device');
    });
  });

  it('keeps the selfie and device of an offline punch, with its original time', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
      const r = await clockIn(c, SAM, 'k1', {
        source: 'offline',
        clientTs: at,
        device: 'dev-off',
        model: 'Moto G',
        selfie: selfieKey(f),
      });
      expect(r.error).toBeUndefined();
      const { rows } = await c.query<{ gap: string; selfie_key: string; in_device_id: string }>(
        `select abs(extract(epoch from (a.clock_in_at - $2::timestamptz))) as gap,
                s.selfie_key, a.in_device_id
           from hr.attendance a join hr.attendance_selfie s on s.attendance_id = a.id
          where a.id = $1`,
        [r.rows![0]!.attendance_id, at],
      );
      expect(Number(rows[0]!.gap)).toBeLessThan(1);
      expect(rows[0]).toMatchObject({ selfie_key: selfieKey(f), in_device_id: 'dev-off' });
    });
  });
});

describe('who sees a selfie', () => {
  async function punch(c: PoolClient) {
    const f = await fixture(c);
    const r = await clockIn(c, SAM, 'k1', { device: 'dev-sam-1', selfie: selfieKey(f) });
    return { f, attendance: r.rows![0]!.attendance_id };
  }
  const key = (c: PoolClient, who: string, attendance: string) =>
    attemptAs<{ k: string | null }>(c, ids.user(who), 'select hr.selfie_of($1) as k', [attendance]);

  it('shows it to the person, the head of their department and HR', async () => {
    await inRolledBackTx(async (c) => {
      const { f, attendance } = await punch(c);
      for (const who of [SAM, FLOOR, HARPER]) {
        const r = await key(c, who, attendance);
        expect(r.error, who).toBeUndefined();
        expect(r.rows![0]!.k, who).toBe(selfieKey(f));
      }
    });
  });

  it('does not show it to the GM, the area manager, a colleague or another company', async () => {
    await inRolledBackTx(async (c) => {
      const { attendance } = await punch(c);
      for (const who of [OLIVIA, ARIA, PAT, OTHER_COMPANY]) {
        expect((await key(c, who, attendance)).error, who).toBe('NOT_AUTHORISED');
      }
    });
  });

  it('is not readable through the table by those who may not see the selfie', async () => {
    await inRolledBackTx(async (c) => {
      const { attendance } = await punch(c);
      const rows = async (who: string) =>
        (
          await attemptAs<{ k: string }>(
            c,
            ids.user(who),
            'select selfie_key as k from hr.attendance_selfie where attendance_id = $1',
            [attendance],
          )
        ).rows ?? [];
      expect(await rows(FLOOR)).toHaveLength(1);
      expect(await rows(HARPER)).toHaveLength(1);
      for (const who of [OLIVIA, ARIA, PAT, OTHER_COMPANY])
        expect(await rows(who), who).toEqual([]);
    });
  });

  it('lists the exceptions for the head of the department, with the new kinds', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      await clockIn(c, SAM, 'k1', { device: 'shared-3' });
      await clockIn(c, PAT, 'k2', { device: 'shared-3' });
      const r = await attemptAs<{ kind: string }>(
        c,
        ids.user(FLOOR),
        `select kind from hr.exception_queue($1, 'open')`,
        [ids.node('TEST-BAR-3.0')],
      );
      expect(r.error).toBeUndefined();
      const kinds = r.rows!.map((x) => x.kind);
      expect(kinds).toContain('no_selfie');
      expect(kinds).toContain('shared_device');
      void f;
    });
  });
});

describe('keeping selfies (NFR Data retention)', () => {
  it('works out the cut-off: a year, the previous calendar year or the previous financial year, whichever is earliest', async () => {
    await inRolledBackTx(async (c) => {
      const cut = async (d: string) =>
        (
          await c.query<{ d: string }>(
            `select to_char(hr.personnel_cutoff($1::date), 'YYYY-MM-DD') as d`,
            [d],
          )
        ).rows[0]!.d;
      expect(await cut('2026-09-15')).toBe('2025-01-01'); // the brief's example
      expect(await cut('2027-03-10')).toBe('2025-04-01'); // the previous financial year starts earlier
      expect(await cut('2026-02-01')).toBe('2024-04-01');
    });
  });

  it('removes the selfie, not the clock-in, from punches older than the cut-off', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const old = await clockIn(c, SAM, 'k1', { device: 'dev-old', selfie: selfieKey(f) });
      await clockOut(c, SAM, 'o1');
      await c.query(
        `update hr.attendance set clock_in_at = date '2024-06-01' + time '09:00',
                clock_out_at = date '2024-06-01' + time '17:00' where id = $1`,
        [old.rows![0]!.attendance_id],
      );
      const fresh = await clockIn(c, SAM, 'k2', { device: 'dev-old', selfie: selfieKey(f, 2) });
      const { rows } = await c.query<{ n: number }>(
        `select hr.purge_personnel(timestamptz '2026-09-15 03:00+00') as n`,
      );
      expect(rows[0]!.n).toBeGreaterThanOrEqual(1);
      const left = await c.query<{
        attendance_id: string;
        selfie_key: string | null;
        purged_at: string | null;
      }>(
        `select attendance_id, selfie_key, purged_at from hr.attendance_selfie
          where attendance_id = any($1)`,
        [[old.rows![0]!.attendance_id, fresh.rows![0]!.attendance_id]],
      );
      const by = new Map(left.rows.map((r) => [r.attendance_id, r]));
      expect(by.get(old.rows![0]!.attendance_id)!.selfie_key).toBeNull();
      expect(by.get(old.rows![0]!.attendance_id)!.purged_at).not.toBeNull();
      expect(by.get(fresh.rows![0]!.attendance_id)!.selfie_key).toBe(selfieKey(f, 2));
      // the clock-in itself stays
      const stays = await c.query('select 1 from hr.attendance where id = $1', [
        old.rows![0]!.attendance_id,
      ]);
      expect(stays.rowCount).toBe(1);
    });
  });
});
