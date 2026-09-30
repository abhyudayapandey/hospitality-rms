import 'server-only';
import { DEFAULT_TZ } from './dates';
import { sql, type Tx } from './db';
import { param, type SearchParams } from './inventory';
import { loadShell, type NodeRow, type Shell } from './shell';

// Reads for the people screens (roster, attendance, leave, swaps, events). Every query
// runs inside withUser, so RLS decides what is visible; access here only chooses what to
// show (ADR 004). Manager lists are filtered by one org node (ADR 007).

export interface PeopleContext {
  shell: Shell;
  /** org nodes the user can see: outlets and sites first */
  nodes: NodeRow[];
  node: NodeRow | null;
  tz: string;
  can(domain: string, access?: 'view' | 'modify'): boolean;
}

const WORKPLACE = new Set(['outlet', 'site']);

/** The org node the people screens work on: ?node=, the current node, or the first outlet. */
export async function peopleContext(sp: SearchParams): Promise<PeopleContext> {
  const shell = await loadShell();
  const wanted = param(await sp, 'node');
  const nodes = shell.nodes
    .filter((n) => n.type === 'org')
    .sort((a, b) => Number(!WORKPLACE.has(a.kind)) - Number(!WORKPLACE.has(b.kind)));
  const node =
    nodes.find((n) => n.id === wanted) ??
    nodes.find((n) => n.id === shell.currentNode?.id && WORKPLACE.has(n.kind)) ??
    nodes.find((n) => WORKPLACE.has(n.kind)) ??
    nodes[0] ??
    null;
  return {
    shell,
    nodes,
    node,
    tz: node?.timezone ?? DEFAULT_TZ,
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
}

export async function candidates(tx: Tx, shift: string): Promise<Candidate[]> {
  const r = await sql<Candidate>`
    select worker_id, display_name, violation, violation_detail, week_hours
      from hr.assign_candidates(${shift}::uuid)`.execute(tx);
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
  no_show: 'No show',
  missing_clock_out: 'No clock-out',
  unscheduled: 'Not rostered',
  outside_geofence: 'Outside the outlet',
  no_location: 'No location',
};

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
