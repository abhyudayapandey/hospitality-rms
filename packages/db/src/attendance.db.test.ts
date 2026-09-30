import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actAs,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  resetRole,
  type SeedIds,
} from '../test/helpers';
import { clearWorkforce, newUser, newWorker, tenantOf, workerFor } from '../test/workforce';

// Attendance (ADR 008): clock in/out with geofence flags (never blocking), offline replay
// with device timestamps and idempotency keys, the nightly exceptions job, the 90-day
// coordinate purge, resolving exceptions, and self-service RLS.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const HERE = { lat: 12.9716, lng: 77.5946 }; // Outlet A's fence centre
const FAR = { lat: 12.9816, lng: 77.5946 }; // ~1.1 km north

interface Fx {
  tenant: string;
  sam: string;
  pat: { userId: string; workerId: string };
  olivia: string;
}

async function fixture(c: PoolClient): Promise<Fx> {
  await clearWorkforce(c);
  const tenant = await tenantOf(c, ids);
  const sam = await workerFor(c, ids, 'test.server.3.0', 'TEST-BAR-3.0-FLOOR-SERVICE', 'SERVER');
  const olivia = await workerFor(
    c,
    ids,
    'test.bar-manager.3.0',
    'TEST-BAR-3.0-FLOOR-SERVICE',
    'MANAGER',
  );
  const pat = await newWorker(c, ids, 'Pat Server', 'TEST-BAR-3.0-FLOOR-SERVICE', 'SERVER');
  await c.query(
    `insert into hr.node_setting (tenant_id, org_node_id, latitude, longitude)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, org_node_id) do update
       set latitude = excluded.latitude, longitude = excluded.longitude, geofence_radius_m = 150`,
    [tenant, ids.node('TEST-BAR-3.0-FLOOR-SERVICE'), HERE.lat, HERE.lng],
  );
  return { tenant, sam, pat, olivia };
}

/** A published shift for `worker` starting `startOffset` from now, lasting `hours`. */
async function rostered(c: PoolClient, worker: string, startOffset: string, hours = 8) {
  const { rows } = await c.query<{ id: string }>(
    `with w as (select * from hr.worker where id = $1),
     s as (insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at, role_code,
                                 status, published_at)
           select tenant_id, org_node_id,
                  ((now() + $2::interval) at time zone 'Asia/Kolkata')::date,
                  now() + $2::interval, now() + $2::interval + make_interval(hours => $3),
                  role_code, 'published', now() from w returning *)
     insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id, org_node_id,
                                      start_at, end_at)
     select s.tenant_id, s.id, w.id, w.owner_user_id, s.org_node_id, s.start_at, s.end_at
       from s, w returning shift_id as id`,
    [worker, startOffset, hours],
  );
  return rows[0]!.id;
}

interface Punch {
  attendance_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  shift_id: string | null;
  inside: boolean | null;
  distance_m: string | null;
  flags: string[];
}

async function clock(
  c: PoolClient,
  user: string,
  action: 'in' | 'out',
  where: { lat: number; lng: number } | null,
  key: string,
  opts: { source?: 'online' | 'offline'; clientTs?: string } = {},
) {
  return attemptAs<Punch>(
    c,
    user,
    `select * from hr.clock($1, $2, $3, 10, $4::timestamptz, $5, $6)`,
    [
      action,
      where?.lat ?? null,
      where?.lng ?? null,
      opts.clientTs ?? null,
      opts.source ?? 'online',
      key,
    ],
  );
}

const SAM = () => ids.user('test.server.3.0');
const OLIVIA = () => ids.user('test.bar-manager.3.0');

describe('hr.clock', () => {
  it('clocks in inside the fence against the shift, idempotently; out outside is flagged, not blocked', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const shift = await rostered(c, f.sam, '30 minutes');
      const first = await clock(c, SAM(), 'in', HERE, 'k-in-1');
      expect(first.error).toBeUndefined();
      const p = first.rows![0]!;
      expect(p).toMatchObject({ shift_id: shift, inside: true, distance_m: '0.0', flags: [] });

      const replay = await clock(c, SAM(), 'in', HERE, 'k-in-1');
      expect(replay.rows![0]!.attendance_id).toBe(p.attendance_id);
      expect((await clock(c, SAM(), 'in', HERE, 'k-in-2')).error).toBe('ALREADY_CLOCKED_IN');

      const out = await clock(c, SAM(), 'out', FAR, 'k-out-1');
      expect(out.error).toBeUndefined();
      expect(out.rows![0]).toMatchObject({
        attendance_id: p.attendance_id,
        inside: false,
        flags: ['outside_geofence'],
      });
      expect(Number(out.rows![0]!.distance_m)).toBeGreaterThan(1000);
      // replayed clock-out: same result, one exception
      expect((await clock(c, SAM(), 'out', FAR, 'k-out-1')).rows![0]!.flags).toEqual([
        'outside_geofence',
      ]);
      const ex = await c.query<{ kind: string; phase: string }>(
        'select kind, phase from hr.attendance_exception where attendance_id = $1',
        [p.attendance_id],
      );
      expect(ex.rows).toEqual([{ kind: 'outside_geofence', phase: 'out' }]);
      expect((await clock(c, SAM(), 'out', HERE, 'k-out-2')).error).toBe('NOT_CLOCKED_IN');
    });
  });

  it('flags a punch without location where a fence exists; no fence, no flag', async () => {
    await inRolledBackTx(async (c) => {
      await fixture(c);
      const r = await clock(c, SAM(), 'in', null, 'k1');
      expect(r.rows![0]).toMatchObject({ inside: null, flags: ['no_location'], shift_id: null });
      await c.query('delete from hr.node_setting where org_node_id = $1', [
        ids.node('TEST-GUEST-HOUSE-2.0'),
      ]);
      const bea = await newWorker(c, ids, 'Bea Outlet B', 'TEST-GUEST-HOUSE-2.0', 'SERVER');
      const b = await clock(c, bea.userId, 'in', FAR, 'k2');
      expect(b.rows![0]).toMatchObject({ inside: null, distance_m: null, flags: [] });
    });
  });

  it('offline punches keep the device time within 24 h', async () => {
    await inRolledBackTx(async (c) => {
      await fixture(c);
      const ts = (await c.query<{ t: string }>(`select (now() - interval '3 hours')::text t`))
        .rows[0]!.t;
      const r = await clock(c, SAM(), 'in', HERE, 'off-1', { source: 'offline', clientTs: ts });
      expect(r.error).toBeUndefined();
      const row = await c.query<{ ok: boolean; in_source: string }>(
        `select clock_in_at = $2::timestamptz ok, in_source from hr.attendance where id = $1`,
        [r.rows![0]!.attendance_id, ts],
      );
      expect(row.rows[0]).toEqual({ ok: true, in_source: 'offline' });
      const old = (await c.query<{ t: string }>(`select (now() - interval '30 hours')::text t`))
        .rows[0]!.t;
      const future = (await c.query<{ t: string }>(`select (now() + interval '1 hour')::text t`))
        .rows[0]!.t;
      expect(
        (await clock(c, SAM(), 'out', HERE, 'off-2', { source: 'offline', clientTs: old })).error,
      ).toBe('INVALID_TIMESTAMP');
      expect(
        (await clock(c, SAM(), 'out', HERE, 'off-3', { source: 'offline', clientTs: future }))
          .error,
      ).toBe('INVALID_TIMESTAMP');
      // a clock-out before the clock-in is refused
      const before = (await c.query<{ t: string }>(`select (now() - interval '4 hours')::text t`))
        .rows[0]!.t;
      expect(
        (await clock(c, SAM(), 'out', HERE, 'off-4', { source: 'offline', clientTs: before }))
          .error,
      ).toBe('INVALID_TIMESTAMP');
    });
  });

  it('needs a worker and writes nothing directly', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const noWorker = await newUser(c, ids, 'No Worker');
      expect((await clock(c, noWorker, 'in', HERE, 'x')).error).toBe('INVALID_WORKER');
      const direct = await attemptAs(
        c,
        SAM(),
        `insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, clock_in_at,
                                    in_source, in_key)
         values ($1, $2, $3, $4, now(), 'online', 'x')`,
        [f.tenant, f.sam, SAM(), ids.node('TEST-BAR-3.0-FLOOR-SERVICE')],
      );
      expect(direct.error).toMatch(/permission denied/);
    });
  });
});

describe('nightly exceptions', () => {
  async function run(c: PoolClient, asOf = 'now()') {
    await actAs(c, 'wf_executor', null);
    const r = await c.query<{ exceptions: number; purged: number }>(
      `select * from hr.nightly_attendance(${asOf})`,
    );
    await resetRole(c);
    return r.rows[0]!;
  }

  async function punch(
    c: PoolClient,
    worker: string,
    shift: string | null,
    inAt: string,
    outAt: string | null,
  ) {
    await c.query(
      `insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, shift_id,
                                  clock_in_at, clock_out_at, in_source, out_source, in_key)
       select tenant_id, id, owner_user_id, org_node_id, $2, now() + $3::interval,
              now() + $4::interval, 'online', case when $4::text is null then null else 'online' end,
              gen_random_uuid()::text
         from hr.worker where id = $1`,
      [worker, shift, inAt, outAt],
    );
  }

  it('raises late, no_show, missing_clock_out and unscheduled once', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const casey = await workerFor(c, ids, 'test.cook.3.0', 'TEST-BAR-3.0-FLOOR-SERVICE', 'COOK');
      const kim = await workerFor(
        c,
        ids,
        'test.head-cook.3.0',
        'TEST-BAR-3.0-FLOOR-SERVICE',
        'STORE',
      );
      const late = await rostered(c, f.sam, '-20 hours'); // ended 12 h ago
      await punch(c, f.sam, late, '-1185 minutes', '-12 hours'); // 15 min late
      const noShow = await rostered(c, f.pat.workerId, '-20 hours');
      const open = await rostered(c, casey, '-14 hours'); // ended 6 h ago
      await punch(c, casey, open, '-14 hours', null);
      await punch(c, kim, null, '-10 hours', '-5 hours');

      expect((await run(c)).exceptions).toBe(4);
      const { rows } = await c.query<{ kind: string; shift_id: string | null }>(
        `select kind, shift_id from hr.attendance_exception
          where worker_id = any($1) order by kind`,
        [[f.sam, f.pat.workerId, casey, kim]],
      );
      expect(rows).toEqual([
        { kind: 'late', shift_id: late },
        { kind: 'missing_clock_out', shift_id: open },
        { kind: 'no_show', shift_id: noShow },
        { kind: 'unscheduled', shift_id: null },
      ]);
      expect((await run(c)).exceptions).toBe(0);
    });
  });

  it('uses the tenant late threshold', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      await c.query(
        `insert into hr.roster_setting (tenant_id, late_threshold_min) values ($1, 20)
         on conflict (tenant_id) do update set late_threshold_min = 20`,
        [f.tenant],
      );
      const s = await rostered(c, f.sam, '-20 hours');
      await punch(c, f.sam, s, '-1185 minutes', '-12 hours');
      await run(c);
      const n = await c.query(
        `select 1 from hr.attendance_exception where shift_id = $1 and kind = 'late'`,
        [s],
      );
      expect(n.rowCount).toBe(0);
    });
  });

  it('nulls raw coordinates after 90 days, keeping distance and the inside flag', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      for (const [key, age] of [
        ['old', '91 days'],
        ['recent', '89 days'],
      ] as const) {
        await c.query(
          `insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, clock_in_at,
                                      clock_out_at, in_source, out_source, in_key, in_lat, in_lng,
                                      in_distance_m, in_inside, out_lat, out_lng)
           select tenant_id, id, owner_user_id, org_node_id, now() - $2::interval,
                  now() - $2::interval + interval '8 hours', 'online', 'online', $3,
                  12.97, 77.59, 12.5, true, 12.97, 77.59
             from hr.worker where id = $1`,
          [f.sam, age, key],
        );
      }
      expect((await run(c)).purged).toBe(1);
      const { rows } = await c.query(
        `select in_key, in_lat, in_lng, out_lat, in_distance_m, in_inside, geo_purged_at is not null purged
           from hr.attendance where worker_id = $1 order by in_key`,
        [f.sam],
      );
      expect(rows).toEqual([
        {
          in_key: 'old',
          in_lat: null,
          in_lng: null,
          out_lat: null,
          in_distance_m: '12.5',
          in_inside: true,
          purged: true,
        },
        {
          in_key: 'recent',
          in_lat: '12.970000',
          in_lng: '77.590000',
          out_lat: '12.970000',
          in_distance_m: '12.5',
          in_inside: true,
          purged: false,
        },
      ]);
    });
  });

  it('is only callable by the executor role', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(c, OLIVIA(), 'select * from hr.nightly_attendance()');
      expect(r.error).toMatch(/permission denied/);
    });
  });
});

describe('exceptions queue and self-service RLS', () => {
  it('managers resolve other people’s exceptions; staff see only their own', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      await clock(c, SAM(), 'in', FAR, 'a');
      await clock(c, f.pat.userId, 'in', null, 'b');
      await clock(c, OLIVIA(), 'in', FAR, 'c');

      const count = async (user: string, table: string) =>
        (await attemptAs<{ n: string }>(c, user, `select count(*) n from ${table}`)).rows![0]!.n;
      expect(await count(SAM(), 'hr.attendance')).toBe('1');
      expect(await count(SAM(), 'hr.attendance_exception')).toBe('1');
      expect(await count(f.pat.userId, 'hr.attendance')).toBe('1');
      expect(await count(OLIVIA(), 'hr.attendance')).toBe('3');
      expect(await count(ids.user('test.area-manager'), 'hr.attendance_exception')).toBe('3');
      const omar = await newWorker(c, ids, 'Omar B Manager', 'TEST-GUEST-HOUSE-2.0', 'MANAGER', [
        ['OUTLET_MANAGER', 'TEST-GUEST-HOUSE-2.0'],
      ]);
      expect(await count(omar.userId, 'hr.attendance')).toBe('0'); // other outlet
    });
  });

  it('resolve: ATTENDANCE modify at the node, never one’s own', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      await clock(c, SAM(), 'in', FAR, 'a');
      await clock(c, OLIVIA(), 'in', FAR, 'c');
      const exOf = async (worker: string) =>
        (
          await c.query<{ id: string }>(
            'select id from hr.attendance_exception where worker_id = $1',
            [worker],
          )
        ).rows[0]!.id;
      const resolve = 'select hr.resolve_exception($1, $2, $3)';
      expect((await attemptAs(c, SAM(), resolve, [await exOf(f.sam), 'resolved', 'x'])).error).toBe(
        'NOT_AUTHORISED',
      );
      expect(
        (
          await attemptAs(c, ids.user('test.area-manager'), resolve, [
            await exOf(f.sam),
            'resolved',
            'x',
          ])
        ).error,
      ).toBe('NOT_AUTHORISED');
      expect(
        (await attemptAs(c, OLIVIA(), resolve, [await exOf(f.olivia), 'dismissed', 'x'])).error,
      ).toBe('SEGREGATION_OF_DUTIES');
      expect(
        (await attemptAs(c, OLIVIA(), resolve, [await exOf(f.sam), 'resolved', 'phone GPS off']))
          .error,
      ).toBeUndefined();
      const row = await c.query<{ status: string; resolved_by: string }>(
        'select status, resolved_by from hr.attendance_exception where id = $1',
        [await exOf(f.sam)],
      );
      expect(row.rows[0]).toEqual({ status: 'resolved', resolved_by: OLIVIA() });
    });
  });
});
