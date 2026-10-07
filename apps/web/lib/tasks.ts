import 'server-only';
import { sql, type Tx } from './db';
import type { Schedule, StepInput } from './tasks-view';

// Task reads (ADR 020). Every list comes from an ops.* function that checks core.can() or
// the assignee (the app cannot read the people and place tables directly).

export interface MyTask {
  id: string;
  kind: 'one_off' | 'checklist' | 'prep' | 'expiry' | 'receive';
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
}

export async function myTasks(tx: Tx): Promise<MyTask[]> {
  return (await sql<MyTask>`select * from ops.my_tasks()`.execute(tx)).rows;
}

export interface TaskStep {
  id: string;
  position: number;
  label: string;
  kind: 'tick' | 'number' | 'text' | 'photo' | 'discard' | 'batch' | 'receive';
  min: number | null;
  max: number | null;
  unit: string | null;
  photo_required: boolean;
  value_num: number | null;
  value_text: string | null;
  photo_key: string | null;
  flagged: boolean;
  done_at: string | null;
  done_by_name: string | null;
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
  steps: TaskStep[];
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
}

export async function teamTasks(tx: Tx, node: string, from: string, to: string) {
  return (
    await sql<TeamTask>`select * from ops.team_tasks(${node}::uuid, ${from}::date, ${to}::date)`.execute(
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
}

export async function assignablePeople(tx: Tx, node: string): Promise<Person[]> {
  return (await sql<Person>`select * from ops.assignable_people(${node}::uuid)`.execute(tx)).rows;
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
