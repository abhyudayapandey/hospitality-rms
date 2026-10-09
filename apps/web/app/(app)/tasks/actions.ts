'use server';

import { revalidatePath } from 'next/cache';
import {
  failure,
  libraryStepsJson,
  newerLibraryVersion,
  type ActionResult,
} from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';
import {
  copyPhoto,
  isPhotoType,
  keptKey,
  MAX_PHOTO_BYTES,
  photosEnabled,
  presignPhotoUpload,
  presignWastageUpload,
  type PhotoPrefix,
  type UploadTarget,
} from '@/lib/photos';
import { checklist } from '@/lib/tasks';
import type { Schedule, StepInput } from '@/lib/tasks-view';
import { requireModule } from '@/lib/modules-server';

// Task, checklist and maintenance writes (ADR 020). Each calls one ops.* SECURITY DEFINER
// function, which checks core.can() or the task's assignee and raises stable codes
// (CLAUDE.md rule 2). Keys from the form make a double tap return the first result.

export type Assign =
  { mode: 'person'; user_id: string } | { mode: 'job_role'; role: string } | { mode: 'on_shift' };

async function run<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, fn);
    revalidatePath('/tasks', 'layout');
    revalidatePath('/inbox');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, err);
    return f;
  }
}

const json = (v: unknown) => JSON.stringify(v);

export async function createTask(input: {
  node: string;
  title: string;
  description: string;
  due: string;
  priority: 'low' | 'normal' | 'high';
  assign: Assign;
  steps: StepInput[];
  idempotencyKey: string;
}): Promise<ActionResult<{ id: string }>> {
  return run('create_task', async (tx) => {
    const r = await sql<{ id: string }>`
      select ops.create_task(${input.node}::uuid, ${input.title}, ${input.description},
                             ${input.due}::timestamptz, ${input.priority}, ${json(input.assign)}::jsonb,
                             ${json(input.steps)}::jsonb, ${input.idempotencyKey}) as id`.execute(
      tx,
    );
    return { id: r.rows[0]!.id };
  });
}

/**
 * Records one step. A flagged reading's photo is copied to tasks/keep/ (kept 400 days,
 * not 90) and the step pointed at the copy; if the copy fails the step stays recorded.
 */
export async function completeStep(
  task: string,
  step: string,
  value: { done?: boolean; number?: number; text?: string; photo_key?: string | null },
): Promise<ActionResult<{ flagged: boolean }>> {
  const r = await run('complete_step', async (tx) => {
    const x = await sql<{ r: { flagged: boolean } }>`
      select ops.complete_step(${task}::uuid, ${step}::uuid, ${json(value)}::jsonb) as r`.execute(
      tx,
    );
    return x.rows[0]!.r;
  });
  const kept = value.photo_key ? keptKey(value.photo_key) : null;
  if (r.ok && r.data.flagged && kept && photosEnabled()) {
    try {
      await copyPhoto(value.photo_key!, kept);
      await run('keep_step_photo', (tx) =>
        sql`select ops.keep_step_photo(${task}::uuid, ${step}::uuid, ${kept})`.execute(tx),
      );
    } catch (err) {
      console.error('keeping a flagged photo failed', err);
    }
  }
  return r;
}

/** A photo of the task itself (ADR 079): three at most, while it is to do. */
export async function addTaskPhoto(task: string, photoKey: string): Promise<ActionResult<null>> {
  return run('add_task_photo', async (tx) => {
    await sql`select ops.add_task_photo(${task}::uuid, ${photoKey})`.execute(tx);
    return null;
  });
}

export async function completeTask(task: string, note: string): Promise<ActionResult<null>> {
  return run('complete_task', async (tx) => {
    await sql`select ops.complete_task(${task}::uuid, ${note})`.execute(tx);
    return null;
  });
}

/** The signer checks a finished checklist round (ADR 087): signed off, every step checked. */
export async function signOff(task: string): Promise<ActionResult<null>> {
  return run('sign_off', async (tx) => {
    await sql`select ops.sign_off(${task}::uuid)`.execute(tx);
    return null;
  });
}

/** ... or sends it back with what to redo; its steps open again for whoever did it. */
export async function sendBack(task: string, note: string): Promise<ActionResult<null>> {
  return run('send_back', async (tx) => {
    await sql`select ops.send_back(${task}::uuid, ${note})`.execute(tx);
    return null;
  });
}

export async function cancelTask(task: string, reason: string): Promise<ActionResult<null>> {
  return run('cancel_task', async (tx) => {
    await sql`select ops.cancel_task(${task}::uuid, ${reason})`.execute(tx);
    return null;
  });
}

export async function recordTaskBatch(
  task: string,
  qty: number,
  idempotencyKey: string,
): Promise<ActionResult<{ id: string }>> {
  return run('record_task_batch', async (tx) => {
    await requireModule(tx, 'production');
    const r = await sql<{ id: string }>`
      select ops.record_task_batch(${task}::uuid, ${qty}, ${idempotencyKey}) as id`.execute(tx);
    revalidatePath('/stock', 'layout');
    return { id: r.rows[0]!.id };
  });
}

// --- expired batches -----------------------------------------------------------------

export async function reportExpired(
  store: string,
  item: string,
  batchNo: string,
): Promise<ActionResult<{ id: string }>> {
  return run('report_expired', async (tx) => {
    await requireModule(tx, 'production');
    const r = await sql<{ id: string }>`
      select ops.report_expired(${store}::uuid, ${item}::uuid, ${batchNo}) as id`.execute(tx);
    revalidatePath('/stock', 'layout');
    return { id: r.rows[0]!.id };
  });
}

/** Confirms what arrived from the Main Store (ADR 051): it goes into the department's store. */
export async function receiveSent(
  task: string,
  lines: { item_id: string; qty: number }[],
): Promise<ActionResult<null>> {
  return run('receive_sent', async (tx) => {
    await sql`select ops.receive_sent(${task}::uuid, ${JSON.stringify(lines)}::jsonb)`.execute(tx);
    revalidatePath('/stock', 'layout');
    return null;
  });
}

/**
 * Gives a task that is to do to someone at its place, or takes it back: its managers, the
 * head of its people's department, whoever handed it on, and the one with a compliance To
 * do (ADR 051, 073, 074). The database decides who may.
 */
export async function reassignTask(task: string, user: string): Promise<ActionResult<null>> {
  const r = await run('reassign_task', async (tx) => {
    await sql`select ops.reassign_task(${task}::uuid, ${user}::uuid)`.execute(tx);
    return null;
  });
  if (r.ok) {
    revalidatePath('/');
    revalidatePath('/compliance', 'layout');
  }
  return r;
}

export async function assignExpiry(
  task: string,
  user: string,
  due: string,
  remake: boolean,
): Promise<ActionResult<null>> {
  return run('assign_expiry', async (tx) => {
    await requireModule(tx, 'production');
    await sql`select ops.assign_expiry(${task}::uuid, ${user}::uuid, ${due}::timestamptz,
                                       ${remake})`.execute(tx);
    return null;
  });
}

/**
 * Throws the batch away as expired wastage. Above the store's limit the wastage waits for
 * the outlet manager (the assignee may not read wastage rows, so the page says so plainly).
 */
export async function discardExpired(
  task: string,
  qty: number,
  photoKey: string | null,
): Promise<ActionResult<{ id: string }>> {
  return run('discard_expired', async (tx) => {
    await requireModule(tx, 'production');
    const r = await sql<{ id: string }>`
      select ops.discard_expired(${task}::uuid, ${qty}, ${photoKey}) as id`.execute(tx);
    revalidatePath('/stock', 'layout');
    return { id: r.rows[0]!.id };
  });
}

// --- checklists --------------------------------------------------------------------

export async function saveChecklist(input: {
  id: string | null;
  node: string;
  name: string;
  schedule: Schedule;
  assign: Assign;
  steps: StepInput[];
}): Promise<ActionResult<{ id: string }>> {
  return run('save_template', async (tx) => {
    await requireModule(tx, 'checklists');
    const r = await sql<{ id: string }>`
      select ops.save_template(${input.id}::uuid, ${input.node}::uuid, ${input.name},
                               ${json(input.schedule)}::jsonb, ${json(input.assign)}::jsonb,
                               ${json(input.steps)}::jsonb) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

/**
 * "Use the new version" (ADR 068): the starter library's newer steps replace the checklist's;
 * its name, schedule and who it goes to stay. The steps come from the product's library here,
 * never from the browser.
 */
export async function adoptLibraryVersion(id: string): Promise<ActionResult<{ version: number }>> {
  return run('use_library_version', async (tx) => {
    await requireModule(tx, 'checklists');
    const c = await checklist(tx, id);
    const lib = newerLibraryVersion(c?.library_code, c?.library_version);
    if (!c || !lib) throw new Error('INVALID_STATE');
    await sql`
      select ops.use_library_version(${id}::uuid, ${lib.code}, ${lib.version},
                                     ${json(libraryStepsJson(lib))}::jsonb)`.execute(tx);
    revalidatePath('/tasks/checklists', 'layout');
    return { version: lib.version };
  });
}

export async function archiveChecklist(id: string): Promise<ActionResult<null>> {
  return run('archive_template', async (tx) => {
    await requireModule(tx, 'checklists');
    await sql`select ops.archive_template(${id}::uuid)`.execute(tx);
    return null;
  });
}

// --- prep lists ----------------------------------------------------------------------

export async function createPrepTasks(input: {
  store: string;
  lines: { item_id: string; qty: number }[];
  due: string;
  assign: Assign;
}): Promise<ActionResult<{ ids: string[] }>> {
  return run('create_prep_tasks', async (tx) => {
    await requireModule(tx, 'prep_lists');
    const r = await sql<{ ids: string[] }>`
      select ops.create_prep_tasks(${input.store}::uuid, ${json(input.lines)}::jsonb,
                                   ${input.due}::timestamptz, ${json(input.assign)}::jsonb) as ids`.execute(
      tx,
    );
    return { ids: r.rows[0]!.ids };
  });
}

// --- maintenance ---------------------------------------------------------------------

export async function raiseMaintenance(input: {
  place: string;
  title: string;
  description: string;
  photoKey: string | null;
  idempotencyKey: string;
}): Promise<ActionResult<{ id: string }>> {
  return run('raise_maintenance', async (tx) => {
    await requireModule(tx, 'maintenance');
    const r = await sql<{ id: string }>`
      select ops.raise_maintenance(${input.place}::uuid, ${input.title}, ${input.description},
                                   ${input.photoKey}, ${input.idempotencyKey}) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

export async function assignMaintenance(id: string, user: string): Promise<ActionResult<null>> {
  return run('assign_maintenance', async (tx) => {
    await requireModule(tx, 'maintenance');
    await sql`select ops.assign_maintenance(${id}::uuid, ${user}::uuid)`.execute(tx);
    return null;
  });
}

export async function startMaintenance(id: string): Promise<ActionResult<null>> {
  return run('start_maintenance', async (tx) => {
    await requireModule(tx, 'maintenance');
    await sql`select ops.start_maintenance(${id}::uuid)`.execute(tx);
    return null;
  });
}

export async function closeMaintenance(
  id: string,
  photoKey: string | null,
  note: string,
): Promise<ActionResult<null>> {
  return run('close_maintenance', async (tx) => {
    await requireModule(tx, 'maintenance');
    await sql`select ops.close_maintenance(${id}::uuid, ${photoKey}, ${note})`.execute(tx);
    return null;
  });
}

// --- photo uploads -------------------------------------------------------------------

/**
 * One presigned POST, after ops.can_upload_photo() says the caller may add a photo for
 * this purpose at the node (rule 2). The key embeds the tenant and node, and the ops.*
 * function that takes the key accepts only that prefix.
 */
async function presign(
  purpose: 'task' | 'maintenance' | 'discard',
  node: string,
  contentType: string,
  size: number,
): Promise<ActionResult<UploadTarget>> {
  if (!photosEnabled()) return { ok: false, code: 'INVALID_PHOTO', message: 'Photos are off.' };
  if (!isPhotoType(contentType) || size < 1 || size > MAX_PHOTO_BYTES) {
    return failure(new Error('INVALID_PHOTO'));
  }
  const user = await requireUser();
  try {
    const tenant = await withUser(user.id, async (tx) => {
      const r = await sql<{ ok: boolean; tenant: string | null }>`
        select ops.can_upload_photo(${purpose}, ${node}::uuid) as ok,
               core.my_tenant() as tenant`.execute(tx);
      if (!r.rows[0]?.ok || !r.rows[0].tenant) throw new Error('NOT_AUTHORISED');
      return r.rows[0].tenant;
    });
    if (purpose === 'discard') {
      return { ok: true, data: await presignWastageUpload(tenant, node, contentType) };
    }
    const prefix: PhotoPrefix = purpose === 'task' ? 'tasks/routine' : 'tasks/keep';
    return { ok: true, data: await presignPhotoUpload(prefix, tenant, node, contentType) };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('presign upload failed', err);
    return f;
  }
}

export async function getTaskUploadUrl(node: string, contentType: string, size: number) {
  return presign('task', node, contentType, size);
}

export async function getMaintenanceUploadUrl(node: string, contentType: string, size: number) {
  return presign('maintenance', node, contentType, size);
}

export async function getDiscardUploadUrl(node: string, contentType: string, size: number) {
  return presign('discard', node, contentType, size);
}
