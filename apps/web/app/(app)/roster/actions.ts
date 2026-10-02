'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';
import { requireModule } from '@/lib/modules-server';

// People writes: rostering, attendance, leave, swaps, events and notifications. Each calls
// one hr.* / ops.* SECURITY DEFINER function that checks core.can() (CLAUDE.md rule 2);
// status changes on workflow subjects happen only through wf.submit / wf.act and the
// executor (rule 4). Mutating actions take an idempotency key where the function stores
// one; the others are idempotent by nature (repeating returns the same result).

async function run<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, fn);
    for (const p of ['/roster', '/leave', '/events', '/notifications']) revalidatePath(p, 'layout');
    revalidatePath('/inbox');
    revalidatePath('/', 'layout');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, err);
    return f;
  }
}

// ---------------------------------------------------------------------------
// Rostering
// ---------------------------------------------------------------------------

/** Adds the template shifts for tomorrow to day 7 (ADR 024); returns how many. */
export async function addTemplateShifts(node: string): Promise<ActionResult<number>> {
  return run('add_template_shifts', async (tx) => {
    const r = await sql<{ n: number }>`
      select hr.add_template_shifts(${node}::uuid) as n`.execute(tx);
    return r.rows[0]!.n;
  });
}

/** Cancels the unpublished drafts in the next seven days and frees anyone on them. */
export async function discardDrafts(node: string): Promise<ActionResult<number>> {
  return run('discard_drafts', async (tx) => {
    const r = await sql<{ n: number }>`select hr.discard_drafts(${node}::uuid) as n`.execute(tx);
    return r.rows[0]!.n;
  });
}

export async function publishWeek(node: string, monday: string): Promise<ActionResult<number>> {
  return run('publish_week', async (tx) => {
    const r = await sql<{ n: number }>`
      select hr.publish_week(${node}::uuid, ${monday}::date) as n`.execute(tx);
    return r.rows[0]!.n;
  });
}

/**
 * Assign through hr.assign. `accept` names the warnings (rest, weekly hours) the manager
 * saw and assigns past (ADR 019); a warning not named, or any other rule, stops it.
 */
export async function assignShift(
  shift: string,
  worker: string,
  accept: string[] = [],
): Promise<ActionResult<string>> {
  return run('assign', async (tx) => {
    const r = await sql<{ id: string }>`
      select hr.assign(${shift}::uuid, ${worker}::uuid, ${accept}::text[]) as id`.execute(tx);
    return r.rows[0]!.id;
  });
}

export async function unassignShift(assignment: string): Promise<ActionResult<null>> {
  return run('unassign', async (tx) => {
    await sql`select hr.unassign(${assignment}::uuid)`.execute(tx);
    return null;
  });
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export interface PunchInput {
  action: 'in' | 'out';
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  /** device time of the punch (ISO); used for offline replays */
  clientTs: string;
  source: 'online' | 'offline';
  /** the device's key for this punch; replays return the recorded result */
  idempotencyKey: string;
}

export interface PunchResult {
  attendance_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  inside: boolean | null;
  distance_m: string | null;
  flags: string[];
}

export async function clock(input: PunchInput): Promise<ActionResult<PunchResult>> {
  return run('clock', async (tx) => {
    const r = await sql<PunchResult>`
      select attendance_id, clock_in_at, clock_out_at, inside, distance_m, flags
        from hr.clock(${input.action}, ${input.lat}::numeric, ${input.lng}::numeric,
                      ${input.accuracy}::numeric, ${input.clientTs}::timestamptz,
                      ${input.source}, ${input.idempotencyKey})`.execute(tx);
    return r.rows[0]!;
  });
}

export async function resolveException(
  id: string,
  status: 'resolved' | 'dismissed',
  note: string,
): Promise<ActionResult<null>> {
  return run('resolve_exception', async (tx) => {
    await sql`select hr.resolve_exception(${id}::uuid, ${status}, ${note || null})`.execute(tx);
    return null;
  });
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

export async function requestLeave(
  type: string,
  from: string,
  to: string,
  reason: string,
  idempotencyKey: string,
): Promise<ActionResult<string>> {
  return run('request_leave', async (tx) => {
    await requireModule(tx, 'leave');
    const r = await sql<{ id: string }>`
      select hr.request_leave(${type}::uuid, ${from}::date, ${to}::date, ${reason || null},
                              ${idempotencyKey}) as id`.execute(tx);
    return r.rows[0]!.id;
  });
}

// ---------------------------------------------------------------------------
// Shift swaps
// ---------------------------------------------------------------------------

export async function offerSwap(
  assignment: string,
  toWorker: string,
  note: string,
): Promise<ActionResult<string>> {
  return run('request_swap', async (tx) => {
    await requireModule(tx, 'swaps');
    const r = await sql<{ id: string }>`
      select hr.request_swap(${assignment}::uuid, ${toWorker}::uuid, ${note || null}) as id`.execute(
      tx,
    );
    return r.rows[0]!.id;
  });
}

export async function respondSwap(swap: string, accept: boolean): Promise<ActionResult<string>> {
  return run('respond_swap', async (tx) => {
    await requireModule(tx, 'swaps');
    const r = await sql<{ s: string }>`
      select hr.respond_swap(${swap}::uuid, ${accept}) as s`.execute(tx);
    return r.rows[0]!.s;
  });
}

export async function withdrawSwap(swap: string): Promise<ActionResult<null>> {
  return run('withdraw_swap', async (tx) => {
    await requireModule(tx, 'swaps');
    await sql`select hr.withdraw_swap(${swap}::uuid)`.execute(tx);
    return null;
  });
}

/**
 * Approve through hr.approve_swap, which re-runs the rostering rules first. `accept` names
 * the warnings the approver saw (ADR 019).
 */
export async function approveSwap(
  swap: string,
  comment: string,
  accept: string[] = [],
): Promise<ActionResult<string>> {
  return run('approve_swap', async (tx) => {
    const r = await sql<{ s: string }>`
      select hr.approve_swap(${swap}::uuid, ${comment || null}, ${accept}::text[]) as s`.execute(
      tx,
    );
    return r.rows[0]!.s;
  });
}

/** The approver gives the shift to someone else instead: no further approval (ADR 019). */
export async function reassignSwap(
  swap: string,
  worker: string,
  accept: string[] = [],
): Promise<ActionResult<string>> {
  return run('reassign_swap', async (tx) => {
    const r = await sql<{ id: string }>`
      select hr.reassign_swap(${swap}::uuid, ${worker}::uuid, ${accept}::text[]) as id`.execute(tx);
    return r.rows[0]!.id;
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventRequirementInput {
  kind: 'item' | 'role';
  item_id?: string;
  qty?: number;
  role_code?: string;
  headcount?: number;
  starts_at?: string;
  ends_at?: string;
}

export interface EventInput {
  id: string | null;
  node: string;
  name: string;
  startsAt: string;
  endsAt: string;
  covers: number;
  notes: string;
  status: 'planned' | 'confirmed';
  requirements: EventRequirementInput[];
  idempotencyKey: string;
}

export async function saveEvent(input: EventInput): Promise<ActionResult<string>> {
  return run('upsert_event', async (tx) => {
    await requireModule(tx, 'events');
    const r = await sql<{ id: string }>`
      select ops.upsert_event(${input.id}::uuid, ${input.node}::uuid, ${input.name},
                              ${input.startsAt}::timestamptz, ${input.endsAt}::timestamptz,
                              ${input.covers}::int, ${input.notes || null},
                              ${JSON.stringify(input.requirements)}::jsonb, ${input.status},
                              ${input.idempotencyKey}) as id`.execute(tx);
    return r.rows[0]!.id;
  });
}

export async function cancelEvent(id: string): Promise<ActionResult<null>> {
  return run('cancel_event', async (tx) => {
    await requireModule(tx, 'events');
    await sql`select ops.cancel_event(${id}::uuid)`.execute(tx);
    return null;
  });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function markRead(ids: string[] | null): Promise<ActionResult<number>> {
  return run('mark_read', async (tx) => {
    const r = await sql<{ n: number }>`select ops.mark_read(${ids}::uuid[]) as n`.execute(tx);
    return r.rows[0]!.n;
  });
}
