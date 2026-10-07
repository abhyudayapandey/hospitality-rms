'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { failure, type ActionResult } from '@outlet-ops/domain';
import {
  companyCode,
  createPayload,
  draftProblems,
  emptyDraft,
  filesFromDraft,
} from '@outlet-ops/onboarding/templates';
import { sql, withPlatformAdmin, type Tx } from '@/lib/db';
import { requestDryRun } from '@/lib/platform/import-files';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { requireSameOrigin } from '@/lib/security/same-origin';
import { inviteOwner, requestInvites } from '../actions';
import { jobState, loadDraft, saveDraft } from './draft';

// Go live from the set-up wizard (ADR 064), through the jobs that already exist: create the
// customer, dry run the files made from the draft, then apply them and send logins. Each step
// is recorded on the draft, so a page that is closed and opened again carries on.

async function run<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireSameOrigin();
    const admin = await requirePlatformAdmin();
    const data = await withPlatformAdmin(admin, fn);
    revalidatePath('/platform', 'layout');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, (err as Error).name);
    return f;
  }
}

async function draftOf(tx: Tx, id: string) {
  const d = await loadDraft(tx, id);
  if (!d) throw new Error('NOT_FOUND');
  return d;
}

/** "Set up a new customer": a new, empty draft. */
export async function startSetup(): Promise<void> {
  const r = await run('start_setup', (tx) => saveDraft(tx, null, emptyDraft(), 'company'));
  if (!r.ok) throw new Error(r.code);
  redirect(`/platform/setup/${r.data}/company`);
}

export async function archiveSetup(id: string): Promise<ActionResult<null>> {
  return run('archive_setup', async (tx) => {
    await sql`select platform.archive_setup_draft(${id}::uuid)`.execute(tx);
    return null;
  });
}

/** Tap 1: create the customer (once), then its dry run follows (advanceSetup). */
export async function checkSetup(id: string): Promise<ActionResult<null>> {
  return run('check_setup', async (tx) => {
    const { row, draft } = await draftOf(tx, id);
    if (draftProblems(draft).length) throw new Error('INVALID_SETUP');
    if (!row.create_job) {
      const job = (
        await sql<{ id: string }>`
          select platform.request_create_customer(${JSON.stringify(createPayload(draft))}::jsonb) as id`.execute(
          tx,
        )
      ).rows[0]!.id;
      await sql`select platform.set_setup_job(${id}::uuid, 'create', ${job}::uuid)`.execute(tx);
      return null;
    }
    const created = await jobState(tx, row.create_job);
    if (created?.status !== 'done' || !created.tenant_id) return null;
    const job = await requestDryRun(
      tx,
      created.tenant_id,
      companyCode(draft),
      `Set-up: ${draft.company.name}`,
      filesFromDraft(draft),
    );
    await sql`select platform.set_setup_job(${id}::uuid, 'dry_run', ${job}::uuid)`.execute(tx);
    return null;
  });
}

/** Moves on by itself once the worker has finished: the dry run once the customer exists. */
export async function advanceSetup(id: string): Promise<ActionResult<null>> {
  const r = await run('advance_setup', async (tx) => {
    const { row } = await draftOf(tx, id);
    const created = await jobState(tx, row.create_job);
    return { row, created };
  });
  if (!r.ok) return r;
  const { row, created } = r.data;
  if (created?.status === 'done' && !row.dry_run_job && !row.apply_job) return checkSetup(id);
  return { ok: true, data: null };
}

/** Tap 2, after the dry run: apply the same files. */
export async function applySetup(id: string): Promise<ActionResult<null>> {
  return run('apply_setup', async (tx) => {
    const { row } = await draftOf(tx, id);
    const dry = await jobState(tx, row.dry_run_job);
    if (!row.dry_run_job || dry?.status !== 'done' || dry.result?.['ok'] !== true) {
      throw new Error('INVALID_STATE');
    }
    const job = (
      await sql<{ id: string }>`
        select platform.request_import_apply(${row.dry_run_job}::uuid) as id`.execute(tx)
    ).rows[0]!.id;
    await sql`select platform.set_setup_job(${id}::uuid, 'apply', ${job}::uuid)`.execute(tx);
    return null;
  });
}

/**
 * After the apply: the owner's invitation, then everyone with an email. Safe to repeat: the
 * owner is invited once, and the invitations go only to people without a login.
 */
export async function sendSetupLogins(id: string): Promise<ActionResult<number>> {
  const r = await run('setup_logins', async (tx) => {
    const { row } = await draftOf(tx, id);
    const applied = await jobState(tx, row.apply_job);
    if (applied?.status !== 'done' || !row.tenant_id) throw new Error('INVALID_STATE');
    const owner = await jobState(tx, row.create_job);
    const people = (
      await sql<{ username: string; login_type: string; has_login: boolean }>`
        select username, login_type, has_login
          from platform.login_candidates(${row.tenant_id}::uuid)`.execute(tx)
    ).rows;
    const ownerName = owner?.result?.['owner_username'];
    return {
      tenant: row.tenant_id,
      createJob: row.create_job!,
      ownerWaiting: people.some((p) => p.username === ownerName && !p.has_login),
      waiting: people.filter((p) => p.login_type === 'email' && !p.has_login).length,
    };
  });
  if (!r.ok) return r;
  if (r.data.ownerWaiting) {
    const o = await inviteOwner(r.data.createJob);
    if (!o.ok) return o;
  }
  if (r.data.waiting > (r.data.ownerWaiting ? 1 : 0)) {
    const i = await requestInvites(r.data.tenant);
    if (!i.ok) return i;
  }
  return { ok: true, data: r.data.waiting };
}
