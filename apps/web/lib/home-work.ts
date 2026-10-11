import 'server-only';
import { weekStart } from './dates';
import { sql, type Tx } from './db';
import { breakfastDay, breakfastOutlets, givesRooms, roomOutlets, rooms } from './rooms';
import { minibarPlaces, minibarRooms, minibarToCharge, type ToChargeRow } from './minibar';
import type { Shell } from './shell';
import { listHref } from './stock-view';

// The cards that put a person's own job on Home (ADR 113): their rooms, the minibar bills to
// post, the next breakfast, the events coming up. Each reads an ops.* function that checks
// access itself (rule 2); a card shows only when it has something of theirs.

export interface HomeRooms {
  outlet: string;
  /** the rooms given to me today (ADR 111), as tiles */
  mine: {
    room_id: string;
    number: string;
    floor: string | null;
    status: string;
    can_set: boolean;
  }[];
  /** every room's status, for the board */
  all: { status: string }[];
  gives: boolean;
}

export interface HomeMinibar {
  outlet: string;
  /** checks to put on the guest's bill (the front desk, ADR 104) */
  charge: ToChargeRow[] | null;
  /** rooms whose minibar is still to check today, mine first (ADR 111) */
  check: { number: string; mine: boolean }[] | null;
}

export interface HomeBreakfast {
  outlet: string;
  day: string;
  today: string;
  buffet: number | null;
  inRoom: number | null;
  rooms: number;
  canEdit: boolean;
}

export interface HomeEvent {
  id: string;
  node: string;
  name: string;
  starts_at: Date;
  ends_at: Date;
  covers: number;
  /** people needed and rostered, per job role (ops.event_staffing) */
  needed: number;
  rostered: number;
}

export async function homeRooms(tx: Tx, shell: Shell): Promise<HomeRooms | null> {
  if (!shell.domains.has('ROOMS')) return null;
  const o = (await roomOutlets(tx))[0];
  if (!o) return null;
  const list = await rooms(tx, o.outlet_id);
  return {
    outlet: o.outlet_id,
    mine: list
      .filter((r) => r.mine)
      .map((r) => ({
        room_id: r.room_id,
        number: r.number,
        floor: r.floor,
        status: r.status,
        can_set: r.can_set,
      })),
    all: list.map((r) => ({ status: r.status })),
    gives: await givesRooms(tx, o.outlet_id),
  };
}

export async function homeMinibar(tx: Tx, shell: Shell): Promise<HomeMinibar | null> {
  if (!shell.domains.has('MINIBAR')) return null;
  const p = (await minibarPlaces(tx))[0];
  if (!p) return null;
  if (p.bills) {
    return { outlet: p.outlet_id, charge: await minibarToCharge(tx, p.outlet_id), check: null };
  }
  if (!p.can_check) return null;
  const due = (await minibarRooms(tx, p.outlet_id)).filter((r) => r.due_today);
  return {
    outlet: p.outlet_id,
    charge: null,
    check: [...due.filter((r) => r.mine), ...due.filter((r) => !r.mine)].map((r) => ({
      number: r.number,
      mine: r.mine,
    })),
  };
}

export async function homeBreakfast(tx: Tx, shell: Shell): Promise<HomeBreakfast | null> {
  if (!shell.breakfast) return null;
  const o = (await breakfastOutlets(tx))[0];
  if (!o) return null;
  const modes = await breakfastDay(tx, o.outlet_id, o.next_day);
  const of = (m: string) => modes.find((x) => x.mode === m);
  return {
    outlet: o.outlet_id,
    day: o.next_day,
    today: o.today,
    buffet: of('buffet')?.total ?? null,
    inRoom: of('in_room')?.total ?? null,
    rooms: of('in_room')?.rooms ?? 0,
    canEdit: modes.some((m) => m.can_edit),
  };
}

/** Events in the next seven days where they plan events (EVENTS modify), with their people. */
export async function homeEvents(tx: Tx, shell: Shell): Promise<HomeEvent[]> {
  if (shell.domains.get('EVENTS') !== 'modify') return [];
  return (
    await sql<HomeEvent>`
      select e.id::text, e.org_node_id::text as node, e.name, e.starts_at, e.ends_at, e.covers,
             coalesce(s.needed, 0)::int as needed, coalesce(s.rostered, 0)::int as rostered
        from ops.event e
        left join lateral (
          select sum(x.needed) as needed, sum(least(x.rostered, x.needed)) as rostered
            from ops.event_staffing(e.id) x) s on true
       where e.status <> 'cancelled' and e.ends_at > now()
         and e.starts_at < now() + interval '7 days'
         and core.can('EVENTS', 'modify', e.org_node_id, null)
       order by e.starts_at
       limit 5`.execute(tx)
  ).rows;
}

/** Tomorrow at the places where they build the roster (ADR 112, 113): rostered and open. */
export interface HomeTomorrow {
  day: string;
  rostered: number;
  needed: number;
  href: string;
}

export async function homeTomorrow(tx: Tx, day: string): Promise<HomeTomorrow | null> {
  const r = (
    await sql<{ rostered: number; needed: number }>`
      select coalesce(sum(least(s.headcount,
                                (select count(*) from hr.shift_assignment a
                                  where a.shift_id = s.id and a.status = 'assigned'))), 0)::int
               as rostered,
             coalesce(sum(s.headcount), 0)::int as needed
        from hr.shift s
       where s.status <> 'cancelled' and s.local_date = ${day}::date
         and core.can('ROSTER', 'modify', s.org_node_id, null)`.execute(tx)
  ).rows[0];
  if (!r || r.needed === 0) return null;
  return {
    day,
    rostered: r.rostered,
    needed: r.needed,
    href: listHref('/roster/week', { all: true, week: weekStart(day), day }),
  };
}
