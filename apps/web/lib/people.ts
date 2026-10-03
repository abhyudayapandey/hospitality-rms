import 'server-only';
import { DEFAULT_TZ } from './dates';
import { sql, withUser, type Tx } from './db';
import type { SearchParams } from './params';
import { pickPlace, screenPlaces, type Place, type Screen } from './places';
import type { TabAccess } from './roster-view';
import type { TimelineRow } from './timeline';
import { loadShell, type Shell } from './shell';

// Reads for the people screens (roster, attendance, leave, swaps, events). Every query
// runs inside withUser, so RLS decides what is visible; access here only chooses what to
// show (ADR 004). Manager lists are filtered by one org node (ADR 007).

export type PeopleScreen = Extract<
  Screen,
  'roster' | 'exceptions' | 'events' | 'team_people' | 'team_leave'
>;

export interface PeopleContext {
  shell: Shell;
  /** the screen's places (departments, or outlets for events); empty on personal screens */
  screen: PeopleScreen | null;
  nodes: Place[];
  node: Place | null;
  tz: string;
  /** People tabs beyond domain checks (audit #10, #13). */
  tabs: { personal: boolean; exceptions: boolean };
  can(domain: string, access?: 'view' | 'modify'): boolean;
}

/**
 * The people screens (ADR 016). Roster, exceptions and events show one place, picked with
 * the "Viewing:" switcher; the personal screens (my shifts, clock, leave, swaps) show none
 * and use the time zone of the person's home place.
 */
export async function peopleContext(
  sp: SearchParams,
  screen: PeopleScreen | null = null,
): Promise<PeopleContext> {
  const shell = await loadShell();
  const { nodes, exceptions } = await withUser(shell.user.id, async (tx) => {
    const nodes = screen ? await screenPlaces(tx, screen, shell) : [];
    const exceptions =
      screen === 'exceptions'
        ? nodes.length > 0
        : shell.domains.get('ATTENDANCE') === 'modify' &&
          (
            await sql<{ v: boolean }>`
              select exists (select 1 from core.screen_places('exceptions')) as v`.execute(tx)
          ).rows[0]!.v;
    return { nodes, exceptions };
  });
  const node = screen ? await pickPlace(screen, nodes, sp) : null;
  const home = shell.nodes.find((n) => n.id === shell.home?.id);
  return {
    shell,
    screen,
    nodes,
    node,
    tz: node?.timezone ?? home?.timezone ?? DEFAULT_TZ,
    tabs: { personal: shell.home?.at_workplace ?? false, exceptions },
    can(domain, access = 'view') {
      const a = shell.domains.get(domain);
      return a !== undefined && (access === 'view' || a === 'modify');
    },
  };
}

export interface MyWorker {
  id: string;
  org_node_id: string;
  role_code: string;
  node_name: string;
}

export async function myWorker(tx: Tx): Promise<MyWorker | null> {
  const r = await sql<MyWorker>`
    select w.id, w.org_node_id, w.role_code, core.node_name(w.org_node_id) as node_name
      from hr.worker w
     where w.owner_user_id = core.current_user_id() and w.status = 'active'`.execute(tx);
  return r.rows[0] ?? null;
}

export interface MyShift {
  assignment_id: string;
  shift_id: string;
  local_date: string;
  start_at: Date;
  end_at: Date;
  role_code: string;
  node_name: string;
  open_swap: string | null;
}

/** The current user's published shifts from `from` (local date) for `days` days. */
export async function myShifts(tx: Tx, from: string, days: number): Promise<MyShift[]> {
  const r = await sql<MyShift>`
    select a.id as assignment_id, s.id as shift_id, s.local_date::text as local_date,
           s.start_at, s.end_at, s.role_code, core.node_name(s.org_node_id) as node_name,
           (select sw.status from hr.shift_swap sw
             where sw.assignment_id = a.id and sw.status in ('proposed', 'submitted')) as open_swap
      from hr.shift_assignment a
      join hr.shift s on s.id = a.shift_id and s.status = 'published'
     where a.owner_user_id = core.current_user_id() and a.status = 'assigned'
       and s.local_date between ${from}::date and ${from}::date + ${days}::int
     order by s.start_at`.execute(tx);
  return r.rows;
}

/**
 * The current user's shifts and clock sessions for local days from..to, matched and split
 * by hr.my_timeline (ADR 018). Times come back as ISO strings.
 */
export async function myTimeline(tx: Tx, from: string, to: string): Promise<TimelineRow[]> {
  const r = await sql<TimelineRow>`
    select local_date::text as local_date, kind, shift_id,
           to_json(shift_start) #>> '{}' as shift_start, to_json(shift_end) #>> '{}' as shift_end,
           to_json(from_at) #>> '{}' as from_at, to_json(to_at) #>> '{}' as to_at,
           minutes, status, late_min, early_min, role_code, place_name
      from hr.my_timeline(${from}::date, ${to}::date)`.execute(tx);
  return r.rows;
}

export interface PastSession {
  id: string;
  clock_in_at: Date;
  clock_out_at: Date;
}

/** The current user's closed clock sessions since `from` (local date), newest first. */
export async function pastSessions(tx: Tx, from: string, tz: string): Promise<PastSession[]> {
  const r = await sql<PastSession>`
    select id, clock_in_at, clock_out_at from hr.attendance
     where owner_user_id = core.current_user_id() and clock_out_at is not null
       and clock_in_at >= (${from}::date)::timestamp at time zone ${tz}
     order by clock_in_at desc`.execute(tx);
  return r.rows;
}

export interface OpenPunch {
  id: string;
  clock_in_at: Date;
  shift_id: string | null;
}

export async function openPunch(tx: Tx): Promise<OpenPunch | null> {
  const r = await sql<OpenPunch>`
    select id, clock_in_at, shift_id from hr.attendance
     where owner_user_id = core.current_user_id() and clock_out_at is null`.execute(tx);
  return r.rows[0] ?? null;
}

export interface RosterShift {
  id: string;
  local_date: string;
  start_at: Date;
  end_at: Date;
  role_code: string;
  headcount: number;
  status: 'draft' | 'published' | 'cancelled';
  template_name: string | null;
  people: { assignment_id: string; worker_id: string; name: string }[];
}

/** A node-week of shifts with the people assigned (names from hr.worker_directory). */
export async function weekRoster(tx: Tx, node: string, monday: string): Promise<RosterShift[]> {
  const r = await sql<RosterShift>`
    select s.id, s.local_date::text as local_date, s.start_at, s.end_at, s.role_code, s.headcount,
           s.status, t.name as template_name,
           coalesce((select json_agg(json_build_object('assignment_id', a.id, 'worker_id', a.worker_id,
                                                       'name', coalesce(d.display_name, 'Worker'))
                                     order by d.display_name)
                       from hr.shift_assignment a
                       left join hr.worker_directory d on d.worker_id = a.worker_id
                      where a.shift_id = s.id and a.status = 'assigned'), '[]') as people
      from hr.shift s
      left join hr.shift_template t on t.id = s.template_id
     where s.org_node_id = ${node}::uuid and s.status <> 'cancelled'
       and s.local_date between ${monday}::date and ${monday}::date + 6
     order by s.start_at, s.role_code`.execute(tx);
  return r.rows;
}

export interface Candidate {
  worker_id: string;
  display_name: string;
  violation: string | null;
  violation_detail: string | null;
  week_hours: string;
  /** Rest and weekly hours: shown, and assignable past (ADR 019). */
  warnings: RuleWarning[];
}

export interface RuleWarning {
  code: string;
  /** Worded for "<name> would have ...". */
  detail: string;
}

export async function candidates(tx: Tx, shift: string): Promise<Candidate[]> {
  const r = await sql<Candidate>`
    select worker_id, display_name, violation, violation_detail, week_hours, warnings
      from hr.assign_candidates(${shift}::uuid)`.execute(tx);
  return r.rows;
}

/** Every rule that applies to the colleague taking a swap; for its pending approver. */
export async function swapChecks(
  tx: Tx,
  swap: string,
): Promise<(RuleWarning & { warning: boolean })[]> {
  const r = await sql<RuleWarning & { warning: boolean }>`
    select code, detail, warning from hr.swap_checks(${swap}::uuid)`.execute(tx);
  return r.rows;
}

export interface ExceptionRow {
  id: string;
  place_id: string;
  place_name: string;
  worker_name: string;
  owner_user_id: string;
  local_date: string;
  kind: string;
  phase: string | null;
  detail: Record<string, number>;
  status: string;
  resolution_note: string | null;
  shift_start: Date | null;
  shift_end: Date | null;
  assignee_group: string | null;
  assignee_names: string[] | null;
  assigned_to_me: boolean;
}

/** Exceptions of a place and every department below it, in department order (ADR 009). */
export async function exceptions(
  tx: Tx,
  node: string,
  status: 'open' | 'closed',
): Promise<ExceptionRow[]> {
  const r = await sql<ExceptionRow>`
    select id, place_id, place_name, worker_name, owner_user_id, local_date::text as local_date,
           kind, phase, detail, status, resolution_note, shift_start, shift_end,
           assignee_group, assignee_names, assigned_to_me
      from hr.exception_queue(${node}::uuid, ${status})`.execute(tx);
  return r.rows;
}

export const EXCEPTION_LABEL: Record<string, string> = {
  late: 'Late',
  left_early: 'Left early',
  no_show: 'No show',
  missing_clock_out: 'No clock-out',
  unscheduled: 'Not rostered',
  outside_geofence: 'Outside the outlet',
  no_location: 'No location',
};

export interface MyException {
  id: string;
  local_date: string;
  kind: string;
  status: string;
  resolution_note: string | null;
}

/** The person's own attendance exceptions from `since` (their own rows, SELF). */
export async function myExceptions(tx: Tx, since: string): Promise<MyException[]> {
  const r = await sql<MyException>`
    select id, local_date::text as local_date, kind, status, resolution_note
      from hr.attendance_exception
     where owner_user_id = core.current_user_id() and local_date >= ${since}::date
     order by local_date desc, created_at desc
     limit 20`.execute(tx);
  return r.rows;
}

export interface Balance {
  leave_type_id: string;
  code: string;
  name: string;
  year: number;
  entitled_days: string | null;
  used_days: string;
  pending_days: string;
  available_days: string | null;
}

export async function balances(tx: Tx, worker: string | null, year?: number): Promise<Balance[]> {
  const r = await sql<Balance>`
    select * from hr.leave_balances(${worker}::uuid, ${year ?? null}::int)`.execute(tx);
  return r.rows;
}

export interface LeaveRow {
  id: string;
  type_name: string;
  from_date: string;
  to_date: string;
  days: string;
  status: string;
  reason: string | null;
}

export async function myLeave(tx: Tx): Promise<LeaveRow[]> {
  const r = await sql<LeaveRow>`
    select l.id, t.name as type_name, l.from_date::text, l.to_date::text, l.days, l.status, l.reason
      from hr.leave_request l join hr.leave_type t on t.id = l.leave_type_id
     where l.owner_user_id = core.current_user_id()
     order by l.from_date desc limit 30`.execute(tx);
  return r.rows;
}

export interface SwapRow {
  swap_id: string;
  direction: 'incoming' | 'outgoing';
  status: string;
  start_at: Date;
  end_at: Date;
  role_code: string;
  from_name: string;
  to_name: string;
  note: string | null;
}

export async function mySwaps(tx: Tx): Promise<SwapRow[]> {
  const r = await sql<SwapRow>`
    select swap_id, direction, status, start_at, end_at, role_code, from_name, to_name, note
      from hr.my_swaps()`.execute(tx);
  return r.rows;
}

export interface EventRow {
  id: string;
  org_node_id: string;
  name: string;
  starts_at: Date;
  ends_at: Date;
  covers: number;
  status: string;
  notes: string | null;
  requirements: {
    kind: 'item' | 'role';
    item_id: string | null;
    item_name: string | null;
    base_uom: string | null;
    qty: string | null;
    role_code: string | null;
    headcount: number | null;
    starts_at: string | null;
    ends_at: string | null;
  }[];
}

/** Events at a node from `fromIso`, with current requirements (item names where visible). */
export async function events(
  tx: Tx,
  node: string,
  fromIso: string,
  id?: string,
): Promise<EventRow[]> {
  const r = await sql<EventRow>`
    select e.id, e.org_node_id, e.name, e.starts_at, e.ends_at, e.covers, e.status, e.notes,
           coalesce((select json_agg(json_build_object(
                       'kind', q.kind, 'item_id', q.item_id, 'item_name', i.name,
                       'base_uom', i.base_uom, 'qty', q.qty, 'role_code', q.role_code,
                       'headcount', q.headcount, 'starts_at', q.starts_at, 'ends_at', q.ends_at)
                       order by q.kind, i.name, q.role_code)
                       from ops.event_requirement q
                       left join inv.item i on i.id = q.item_id
                      where q.event_id = e.id and q.archived_at is null), '[]') as requirements
      from ops.event e
     where ${id ? sql`e.id = ${id}::uuid` : sql`e.org_node_id = ${node}::uuid and e.ends_at >= ${fromIso}::timestamptz`}
     order by e.starts_at
     limit 60`.execute(tx);
  return r.rows;
}

export interface UpcomingEvent {
  id: string;
  org_node_id: string;
  name: string;
  starts_at: Date;
  ends_at: Date;
  covers: number;
  place_name: string;
}

/**
 * Events that start in [from, to) at every place the person may see (EVENTS view, RLS);
 * frontline staff read them on My shifts, since Events is on the Team side (ADR 025).
 */
export async function upcomingEvents(
  tx: Tx,
  fromIso: string,
  toIso: string,
): Promise<UpcomingEvent[]> {
  const r = await sql<UpcomingEvent>`
    select e.id, e.org_node_id, e.name, e.starts_at, e.ends_at, e.covers,
           core.node_name(e.org_node_id) as place_name
      from ops.event e
     where e.status <> 'cancelled'
       and e.starts_at >= ${fromIso}::timestamptz and e.starts_at < ${toIso}::timestamptz
     order by e.starts_at
     limit 20`.execute(tx);
  return r.rows;
}

/** What decides the Me and Team tabs (lib/roster-view, ADR 025). */
export function tabAccess(ctx: PeopleContext): TabAccess {
  return { can: (d, a) => ctx.can(d, a), ...ctx.tabs };
}

// ---------------------------------------------------------------------------
// Team → People and Leave (UX-5, ADR 035)
// ---------------------------------------------------------------------------

export interface TeamPerson {
  worker_id: string;
  user_id: string;
  name: string;
  username: string | null;
  job_role: string;
  place_id: string;
  place: string;
  employment_type: string;
  joined_on: string | null;
  status: 'active' | 'inactive';
  waiting: boolean;
  can_deactivate: boolean;
}

/** The place's people; hr.team_people refuses where they don't see worker records. */
export async function teamPeople(tx: Tx, node: string): Promise<TeamPerson[]> {
  const r = await sql<TeamPerson>`
    select worker_id, user_id, name, username, job_role, place_id, place, employment_type,
           joined_on::text, status, waiting, can_deactivate
      from hr.team_people(${node}::uuid)`.execute(tx);
  return r.rows;
}

export interface TeamLeave {
  leave_id: string;
  worker_id: string;
  name: string;
  job_role: string;
  place: string;
  leave_type: string;
  from_date: string;
  to_date: string;
  days: string;
  status: 'submitted' | 'approved';
}

/** Leave waiting or approved at the place over a period (up to three months). */
export async function teamLeave(
  tx: Tx,
  node: string,
  from: string,
  to: string,
): Promise<TeamLeave[]> {
  const r = await sql<TeamLeave>`
    select leave_id, worker_id, name, job_role, place, leave_type, from_date::text,
           to_date::text, days::text, status
      from hr.team_leave(${node}::uuid, ${from}::date, ${to}::date)`.execute(tx);
  return r.rows;
}
