import 'server-only';
import { sql, type Tx } from './db';
import type { Schedule, StepInput } from './tasks-view';

// Task reads (ADR 020). Every list comes from an ops.* function that checks core.can() or
// the assignee (the app cannot read the people and place tables directly).

export interface MyTask {
  id: string;
  kind:
    | 'one_off'
    | 'checklist'
    | 'prep'
    | 'expiry'
    | 'receive'
    | 'licence'
    | 'compliance'
    | 'minibar_refill'
    | 'minibar_bill'
    | 'sign_off'
    | 'handover'
    | 'discard';
  title: string;
  org_node_id: string;
  place_name: string;
  due_at: Date;
  priority: string;
  status: string;
  assign_mode: string;
  taken: boolean;
  steps_total: number;
  steps_done: number;
  overdue: boolean;
  /** the job role whose work this is, when it came to me by cover (ADR 061) */
  covering: string | null;
  /** when it reached me (or my job role), and who gave it to me if someone did (ADR 074) */
  assigned_at: Date | null;
  assigned_by_name: string | null;
  /** when it was done, and who did it when it was someone else (ADR 075) */
  completed_at: Date | null;
  done_by_name: string | null;
}

export async function myTasks(tx: Tx): Promise<MyTask[]> {
  return (await sql<MyTask>`select * from ops.my_tasks()`.execute(tx)).rows;
}

export interface TaskStep {
  id: string;
  position: number;
  label: string;
  kind: 'tick' | 'number' | 'text' | 'photo' | 'discard' | 'batch' | 'receive' | 'yesno' | 'rating';
  min: number | null;
  max: number | null;
  unit: string | null;
  photo_required: boolean;
  value_num: number | null;
  value_text: string | null;
  photo_key: string | null;
  /** the picture it names (ADR 079); null: picked from its words (stepIcon) */
  icon: string | null;
  flagged: boolean;
  done_at: string | null;
  done_by_name: string | null;
  /** a reading out of range: what was done about it; the food probed and whether out-of-date
   * food was thrown away, where the step asks (ADR 088) */
  action_text: string | null;
  food_text: string | null;
  thrown_away: boolean | null;
  asks_food: boolean;
  asks_thrown: boolean;
  /** a round for each room or area: its row, the room and its status (ADR 088) */
  grid_row: string | null;
  room_id: string | null;
  room_status: string | null;
  /** who signed the round off, when it needed it (ADR 087) */
  checked_at: string | null;
  checked_by_name: string | null;
}

export interface TaskDetail {
  id: string;
  kind: MyTask['kind'];
  title: string;
  description: string | null;
  org_node_id: string;
  delivery_node_id: string | null;
  place_name: string;
  store_name: string | null;
  due_at: string;
  priority: string;
  status: 'reported' | 'open' | 'in_progress' | 'done' | 'cancelled';
  assign_mode: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
  assigned_by_name: string | null;
  /** when it reached whoever has it (or its job role) (ADR 074) */
  assigned_at: string | null;
  job_role_name: string | null;
  reported_by_name: string | null;
  item: { sku: string; name: string; unit: string } | null;
  target_qty: number | null;
  batch_no: string | null;
  remake: boolean;
  made_qty: number;
  cancel_reason: string | null;
  completed_at: string | null;
  can_work: boolean;
  can_manage: boolean;
  /** may give it to someone else or take it back (ADR 073, 074) */
  can_hand_on: boolean;
  /** each time it reached someone, oldest first */
  handovers: Handover[];
  /** a sign-off's: the round's steps; anything else's: its own */
  steps: TaskStep[];
  /** a checklist round's sign-off (ADR 087): the rule, who signed it, the latest ask */
  sign_off_rule: string | null;
  signed_off_by_name: string | null;
  signed_off_at: string | null;
  completed_by_name: string | null;
  sent_back_note: string | null;
  sent_back_at: string | null;
  sign_off_task: { id: string; status: string; assignee_name: string | null } | null;
  /** may set the status of the rooms on its grid (ADR 088) */
  can_set_room_status: boolean;
  /** a request to throw something away (ADR 092): whether the GM approves it, and whether I may */
  discard: { needs_gm: boolean; reason: string; can_approve: boolean } | null;
  /** a handover (ADR 089): where and who it came from */
  handover_from: { place: string; by: string; at: string } | null;
  /** a sign-off: the round it checks and who did it */
  signs_off: string | null;
  signs_off_title: string | null;
  signs_off_done_by: string | null;
}

export interface Handover {
  at: string;
  from_name: string | null;
  to_name: string;
  /** null: given by the app (a covered role's task) */
  by_name: string | null;
  /** they took it themselves (the first to start a job role's task) */
  took: boolean;
}

export async function taskDetail(tx: Tx, id: string): Promise<TaskDetail> {
  const r = await sql<{ t: TaskDetail }>`select ops.task_detail(${id}::uuid) as t`.execute(tx);
  return r.rows[0]!.t;
}

export interface TeamTask {
  id: string;
  kind: string;
  title: string;
  place_name: string;
  due_at: Date;
  priority: string;
  status: string;
  assignee_name: string | null;
  pool: string | null;
  steps_total: number;
  steps_done: number;
  flagged: number;
  overdue: boolean;
  assignee_user_id: string | null;
  assigned_at: Date | null;
  assigned_by_name: string | null;
}

export async function teamTasks(tx: Tx, node: string, from: string, to: string) {
  return (
    await sql<TeamTask>`select * from ops.team_tasks(${node}::uuid, ${from}::date, ${to}::date)`.execute(
      tx,
    )
  ).rows;
}

/** What I gave to someone else: still to do, or done today or yesterday (ADR 074, 075). */
export interface HandedOn {
  id: string;
  kind: string;
  title: string;
  place_name: string;
  due_at: Date;
  status: string;
  assignee_name: string | null;
  assigned_at: Date | null;
  overdue: boolean;
  completed_at: Date | null;
  done_by_name: string | null;
}

export async function myHandedOn(tx: Tx): Promise<HandedOn[]> {
  return (await sql<HandedOn>`select * from ops.my_handed_on()`.execute(tx)).rows;
}

/** Who a task can be given to: everyone who works at its place (ops.hand_on_people). */
export async function handOnPeople(tx: Tx, task: string): Promise<Person[]> {
  return (
    await sql<Person>`
      select user_id::text, name, job_role, place_name from ops.hand_on_people(${task}::uuid)`.execute(
      tx,
    )
  ).rows;
}

export interface Completion {
  org_node_id: string;
  place_name: string;
  due: number;
  done: number;
  on_time: number;
  pct: number | null;
}

export async function completion(tx: Tx, node: string, weekStart: string) {
  return (
    await sql<Completion>`select * from ops.completion(${node}::uuid, ${weekStart}::date)`.execute(
      tx,
    )
  ).rows;
}

export interface Checklist {
  id: string;
  org_node_id: string;
  place_name: string;
  name: string;
  schedule: Schedule;
  assign: { mode: string; role?: string; user_id?: string };
  steps: StepInput[];
  archived_at: Date | null;
  /** The starter library checklist and version it was copied from (ADR 062, 068). */
  library_code: string | null;
  library_version: number | null;
}

/** Checklists at the place and below that the person reads. */
export async function checklists(tx: Tx, node: string): Promise<Checklist[]> {
  return (await sql<Checklist>`select * from ops.checklists(${node}::uuid)`.execute(tx)).rows;
}

export async function checklist(tx: Tx, id: string): Promise<Checklist | null> {
  // its place and below is the template itself
  const r = await sql<Checklist>`
    select c.* from ops.checklist_template t, ops.checklists(t.org_node_id) c
     where t.id = ${id}::uuid and c.id = t.id`.execute(tx);
  return r.rows[0] ?? null;
}

export interface Person {
  user_id: string;
  name: string;
  job_role: string | null;
  place_name: string;
  /** on shift there today (ADR 113); undefined where it isn't asked */
  on_shift?: boolean;
}

export async function assignablePeople(tx: Tx, node: string): Promise<Person[]> {
  return (await sql<Person>`select * from ops.assignable_people(${node}::uuid)`.execute(tx)).rows;
}

/**
 * The people a task made now can go to (ADR 113): those on shift there today first, marked, then
 * the rest. A task for today is given to someone who is in.
 */
export async function peopleOnShift(tx: Tx, node: string): Promise<Person[]> {
  const people = await assignablePeople(tx, node);
  const on = new Set(
    (
      await sql<{
        id: string;
      }>`select x::text as id from ops.on_shift_today(${node}::uuid) x`.execute(tx)
    ).rows.map((r) => r.id),
  );
  return [
    ...people.filter((p) => on.has(p.user_id)).map((p) => ({ ...p, on_shift: true })),
    ...people.filter((p) => !on.has(p.user_id)).map((p) => ({ ...p, on_shift: false })),
  ];
}

export interface JobRole {
  code: string;
  name: string;
}

/** Job roles held by someone who works at the place (what a task can go to). */
export async function jobRolesAt(tx: Tx, node: string): Promise<JobRole[]> {
  return (
    await sql<JobRole>`
      select distinct r.code, r.name
        from hr.job_role r
        join ops.assignable_people(${node}::uuid) p on p.job_role = r.name
       order by r.name`.execute(tx)
  ).rows;
}

export interface Maintenance {
  id: string;
  title: string;
  description: string | null;
  status: 'open' | 'assigned' | 'in_progress' | 'done';
  org_node_id: string;
  handled_by: string;
  place_name: string;
  reported_by_name: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  photo_key: string | null;
  done_photo_key: string | null;
  done_note: string | null;
  created_at: Date;
  done_at: Date | null;
  /** where the problem is (org_node_id is the node that handles it) */
  place_node_id: string;
  assigned_at: Date | null;
  assigned_by_name: string | null;
}

/** Requests the person reads: their own, their department's queue, assigned or managed. */
export async function maintenanceList(tx: Tx): Promise<Maintenance[]> {
  return (await sql<Maintenance>`select * from ops.maintenance_requests()`.execute(tx)).rows;
}

export async function maintenanceRequest(tx: Tx, id: string): Promise<Maintenance | null> {
  const r = await sql<Maintenance>`select * from ops.maintenance_requests(${id}::uuid)`.execute(tx);
  return r.rows[0] ?? null;
}

export interface ToAssign {
  id: string;
  kind: 'expiry' | 'maintenance';
  title: string;
  place_name: string;
  reported_at: Date;
  reported_by: string | null;
  org_node_id: string;
}

/** Expired batches and repairs to assign, leaving out switched-off modules (ADR 026). */
export async function toAssign(tx: Tx): Promise<ToAssign[]> {
  return (
    await sql<ToAssign>`
      select a.* from ops.my_to_assign() a
       where (select "on" from core.my_modules()
               where code = case a.kind when 'expiry' then 'production' else 'maintenance' end)`.execute(
      tx,
    )
  ).rows;
}

export interface PrepSuggestion {
  item_id: string;
  sku: string;
  name: string;
  unit: string;
  par: string;
  on_hand: string;
  event_need: string;
  suggested: string;
  open_tasks: string;
}

export async function prepSuggestions(tx: Tx, store: string): Promise<PrepSuggestion[]> {
  return (await sql<PrepSuggestion>`select * from inv.prep_suggestions(${store}::uuid)`.execute(tx))
    .rows;
}

export interface TaskTabs {
  team: boolean;
  create: boolean;
  checklists: boolean;
  prep: boolean;
  /** Maintenance and "Report a problem": the module is on (ADR 026) */
  maintenance: boolean;
}

/**
 * Which task screens have a place for the person (core.screen_places, ADR 016), leaving
 * out the modules their company switched off (core.my_modules, ADR 026).
 */
export async function taskTabs(tx: Tx): Promise<TaskTabs> {
  const r = await sql<TaskTabs>`
    with m as (select code, "on" from core.my_modules())
    select exists (select 1 from core.screen_places('tasks')) as team,
           exists (select 1 from core.screen_places('tasks_new')) as create,
           exists (select 1 from core.screen_places('checklists'))
             and (select "on" from m where code = 'checklists') as checklists,
           exists (select 1 from core.screen_places('tasks_new'))
             and exists (select 1 from core.screen_places('production'))
             and (select "on" from m where code = 'prep_lists') as prep,
           (select "on" from m where code = 'maintenance') as maintenance`.execute(tx);
  return r.rows[0]!;
}

export interface ExpiredLine {
  item_id: string;
  name: string;
  unit: string;
  batch_no: string | null;
  made_qty: string | null;
  wasted_qty: string;
  value: string;
  outcome: string;
  reported_by: string | null;
  discarded_by: string | null;
  remade_qty: string | null;
  wasted_at: Date;
}

/** Expired wastage at a store in the period, with its batch and report (the trace). */
export async function expiredWastage(tx: Tx, store: string, from: string, to: string) {
  return (
    await sql<ExpiredLine>`
      select * from inv.expired_wastage(${store}::uuid, ${from}::date, ${to}::date)`.execute(tx)
  ).rows;
}

// --- a task's own photos, kept 30 days (ADR 079) --------------------------------------

export interface TaskPhoto {
  id: string;
  photo_key: string | null;
  taken_by_name: string;
  taken_at: string;
}

export async function taskPhotos(tx: Tx, task: string): Promise<TaskPhoto[]> {
  const r = await sql<TaskPhoto>`
    select id, photo_key, taken_by_name, taken_at::text from ops.task_photos(${task}::uuid)`.execute(
    tx,
  );
  return r.rows;
}
