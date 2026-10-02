import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closePools, inRolledBackTx } from '../test/helpers';

// Matching punches to shifts, and splitting extra time (Prompt 11a, ADR 018). One SQL
// function, hr.attendance_timeline, does it for My shifts, the Clock screen, the nightly
// exceptions job and the managers' exceptions screen. It is pure (shifts and sessions in,
// rows out), so these cases use literal times and no tables. Times are IST on 5 Oct 2026;
// "+1 06:00" is the next day.

afterAll(closePools);

const UUIDS = Array.from({ length: 9 }, (_, i) => `00000000-0000-7000-8000-00000000000${i + 1}`);
const at = (t: string) => {
  const [d, hm] = t.startsWith('+1 ') ? [6, t.slice(3)] : [5, t];
  return `2026-10-0${d}T${hm}:00+05:30`;
};

type Range = [string, string | null];

interface Case {
  shifts?: Range[];
  sessions?: Range[];
  now?: string;
  late?: number;
  extra?: number;
}

interface Row {
  kind: string;
  shift: number | null;
  from_at: string | null;
  to_at: string | null;
  minutes: number;
  status: string | null;
  late_min: number | null;
  early_min: number | null;
  sessions: number;
}

/** The timeline as compact strings: `kind from–to status [late N] [early N]`. */
async function timeline(c: PoolClient, x: Case): Promise<string[]> {
  return (await rows(c, x)).map((r) =>
    [
      r.kind,
      `${r.from_at ?? '?'}–${r.to_at ?? '?'}`,
      r.status ?? '',
      r.late_min === null ? '' : `late ${r.late_min}`,
      r.early_min === null ? '' : `early ${r.early_min}`,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

async function rows(c: PoolClient, x: Case): Promise<Row[]> {
  const shifts = (x.shifts ?? []).map(([s, e], i) => ({ id: UUIDS[i], start: at(s), end: at(e!) }));
  const sessions = (x.sessions ?? []).map(([i, o], n) => ({
    id: UUIDS[n + 5],
    in: at(i),
    out: o === null ? null : at(o),
  }));
  const { rows } = await c.query<Row & { shift_id: string | null; attendance_ids: string[] }>(
    `select kind, shift_id,
            to_char(from_at at time zone 'Asia/Kolkata', 'HH24:MI') as from_at,
            to_char(to_at at time zone 'Asia/Kolkata', 'HH24:MI') as to_at,
            minutes, status, late_min, early_min, attendance_ids
       from hr.attendance_timeline($1::jsonb, $2::jsonb, $3, $4, $5::timestamptz)`,
    [
      JSON.stringify(shifts),
      JSON.stringify(sessions),
      x.late ?? 10,
      x.extra ?? 30,
      at(x.now ?? '+1 12:00'),
    ],
  );
  return rows.map((r) => ({
    ...r,
    shift: r.shift_id === null ? null : UUIDS.indexOf(r.shift_id),
    sessions: r.attendance_ids.length,
  }));
}

describe('hr.attendance_timeline: the cases in the brief', () => {
  it('shift 08:00–20:00, worked 07:00–19:00: an hour extra before, and left an hour early', async () => {
    await inRolledBackTx(async (c) => {
      expect(
        await timeline(c, { shifts: [['08:00', '20:00']], sessions: [['07:00', '19:00']] }),
      ).toEqual(['extra_before 07:00–08:00', 'shift 08:00–19:00 left_early early 60']);
    });
  });

  it('worked 07:45–20:10: one shift row, the differences only in its In/Out', async () => {
    await inRolledBackTx(async (c) => {
      const r = await rows(c, { shifts: [['08:00', '20:00']], sessions: [['07:45', '20:10']] });
      expect(r.map((x) => [x.kind, x.from_at, x.to_at, x.status, x.minutes])).toEqual([
        ['shift', '07:45', '20:10', 'on_time', 745],
      ]);
    });
  });
});

describe('hr.attendance_timeline: matching', () => {
  it('overnight shifts: late in, extra after the next morning', async () => {
    await inRolledBackTx(async (c) => {
      expect(
        await timeline(c, { shifts: [['22:00', '+1 06:00']], sessions: [['22:30', '+1 06:40']] }),
      ).toEqual(['shift 22:30–06:00 late late 30', 'extra_after 06:00–06:40']);
      expect(
        await timeline(c, { shifts: [['22:00', '+1 06:00']], sessions: [['21:50', '+1 06:05']] }),
      ).toEqual(['shift 21:50–06:05 on_time']);
    });
  });

  it('a session spanning two shifts: each shift gets its own time, the gap is extra after the first', async () => {
    await inRolledBackTx(async (c) => {
      expect(
        await timeline(c, {
          shifts: [
            ['08:00', '12:00'],
            ['13:00', '17:00'],
          ],
          sessions: [['08:00', '17:00']],
        }),
      ).toEqual([
        'shift 08:00–12:00 on_time',
        'extra_after 12:00–13:00',
        'shift 13:00–17:00 on_time',
      ]);
      // a 20-minute gap: shown only in the first shift's Out, unless the setting is 15
      const twoShifts: Case = {
        shifts: [
          ['08:00', '12:00'],
          ['12:20', '16:00'],
        ],
        sessions: [['08:00', '16:00']],
      };
      expect(await timeline(c, twoShifts)).toEqual([
        'shift 08:00–12:20 on_time',
        'shift 12:20–16:00 on_time',
      ]);
      expect(await timeline(c, { ...twoShifts, extra: 15 })).toEqual([
        'shift 08:00–12:00 on_time',
        'extra_after 12:00–12:20',
        'shift 12:20–16:00 on_time',
      ]);
    });
  });

  it('a session within 30 minutes of a shift belongs to it; further away it is unrostered', async () => {
    await inRolledBackTx(async (c) => {
      // ends 10 minutes before the shift starts: that shift's extra time
      expect(
        await timeline(c, {
          shifts: [['08:00', '16:00']],
          sessions: [
            ['07:00', '07:50'],
            ['08:05', '16:00'],
          ],
        }),
      ).toEqual(['extra_before 07:00–07:50', 'shift 08:05–16:00 on_time']);
      // ends 40 minutes before: not this shift's
      expect(
        await timeline(c, {
          shifts: [['08:00', '16:00']],
          sessions: [
            ['06:00', '07:20'],
            ['08:00', '16:00'],
          ],
        }),
      ).toEqual(['unrostered 06:00–07:20 unrostered', 'shift 08:00–16:00 on_time']);
      // no shift that day
      expect(await timeline(c, { sessions: [['14:00', '18:00']] })).toEqual([
        'unrostered 14:00–18:00 unrostered',
      ]);
    });
  });

  it('a session that only touches a shift from outside: its time is extra, the shift a no-show', async () => {
    await inRolledBackTx(async (c) => {
      expect(
        await timeline(c, { shifts: [['08:00', '16:00']], sessions: [['16:15', '17:00']] }),
      ).toEqual(['shift ?–? no_show', 'extra_after 16:15–17:00']);
    });
  });

  it('a break: two sessions in one shift are one row, first In and last Out', async () => {
    await inRolledBackTx(async (c) => {
      const r = await rows(c, {
        shifts: [['08:00', '20:00']],
        sessions: [
          ['08:00', '13:00'],
          ['13:30', '20:00'],
        ],
      });
      expect(r.map((x) => [x.kind, x.from_at, x.to_at, x.status, x.minutes, x.sessions])).toEqual([
        ['shift', '08:00', '20:00', 'on_time', 690, 2],
      ]);
    });
  });
});

describe('hr.attendance_timeline: statuses', () => {
  it('late after the threshold; within it, on time', async () => {
    await inRolledBackTx(async (c) => {
      const s: Range[] = [['08:00', '20:00']];
      expect(await timeline(c, { shifts: s, sessions: [['08:15', '20:00']] })).toEqual([
        'shift 08:15–20:00 late late 15',
      ]);
      expect(await timeline(c, { shifts: s, sessions: [['08:05', '20:00']] })).toEqual([
        'shift 08:05–20:00 on_time',
      ]);
      expect(await timeline(c, { shifts: s, sessions: [['08:15', '20:00']], late: 20 })).toEqual([
        'shift 08:15–20:00 on_time',
      ]);
      // late and left early: both reported
      expect(await timeline(c, { shifts: s, sessions: [['08:30', '18:00']] })).toEqual([
        'shift 08:30–18:00 late late 30 early 120',
      ]);
    });
  });

  it('upcoming, due, no-show', async () => {
    await inRolledBackTx(async (c) => {
      const s: Range[] = [['08:00', '20:00']];
      expect(await timeline(c, { shifts: s, now: '07:00' })).toEqual(['shift ?–? upcoming']);
      expect(await timeline(c, { shifts: s, now: '09:00' })).toEqual(['shift ?–? due']);
      expect(await timeline(c, { shifts: s, now: '20:00' })).toEqual(['shift ?–? no_show']);
    });
  });

  it('an open session: in progress, then a missing clock-out 4 h after the shift', async () => {
    await inRolledBackTx(async (c) => {
      const x: Case = { shifts: [['08:00', '20:00']], sessions: [['07:58', null]] };
      const r = await rows(c, { ...x, now: '10:12' });
      expect(r.map((y) => [y.kind, y.from_at, y.to_at, y.status, y.minutes])).toEqual([
        ['shift', '07:58', null, 'in_progress', 134], // "2 h 14 m"
      ]);
      expect(await timeline(c, { ...x, now: '23:59' })).toEqual(['shift 07:58–? in_progress']);
      expect(await timeline(c, { ...x, now: '+1 00:00' })).toEqual([
        'shift 07:58–? missing_clock_out',
      ]);
      // unrostered: 16 h after the clock-in
      expect(await timeline(c, { sessions: [['10:00', null]], now: '+1 01:59' })).toEqual([
        'unrostered 10:00–? in_progress',
      ]);
      expect(await timeline(c, { sessions: [['10:00', null]], now: '+1 02:00' })).toEqual([
        'unrostered 10:00–? missing_clock_out',
      ]);
    });
  });

  it('clocked out while the shift is still running: not "left early" until it ends', async () => {
    await inRolledBackTx(async (c) => {
      const x: Case = { shifts: [['08:00', '20:00']], sessions: [['08:00', '13:00']] };
      expect(await timeline(c, { ...x, now: '14:00' })).toEqual(['shift 08:00–13:00 clocked_out']);
      expect(await timeline(c, { ...x, now: '20:00' })).toEqual([
        'shift 08:00–13:00 left_early early 420',
      ]);
    });
  });

  it('an open session never spans into the next shift', async () => {
    await inRolledBackTx(async (c) => {
      expect(
        await timeline(c, {
          shifts: [
            ['08:00', '16:00'],
            ['+1 08:00', '+1 16:00'],
          ],
          sessions: [['08:00', null]],
          now: '+1 12:00',
        }),
      ).toEqual(['shift 08:00–? missing_clock_out', 'shift ?–? due']);
    });
  });
});
