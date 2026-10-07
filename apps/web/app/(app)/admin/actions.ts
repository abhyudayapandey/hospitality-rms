'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { loginDirectory } from '@/lib/auth/directory';
import { generateTemporaryPassword } from '@/lib/auth/passwords';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';
import { LIMITS, withinLimit } from '@/lib/security/rate-limit';
import { requireSameOrigin } from '@/lib/security/same-origin';

// User administration (ADR 011). Every action checks the request's origin, then calls a
// core.* SECURITY DEFINER function that checks scope, rank and self-changes and writes the
// audit row. Only after the database has agreed does the Cognito step run; each Cognito
// step can be retried. Temporary passwords are returned once and never stored or logged.

async function run<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireSameOrigin();
    const user = await requireUser();
    const data = await withUser(user.id, fn);
    revalidatePath('/admin', 'layout');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, (err as Error).name);
    return f;
  }
}

export interface PreviewRow {
  access_group: string;
  node_code: string;
  place_name: string;
  covers: string;
  source: string | null;
  applies: 'now' | 'approval' | 'sole owner: now';
}

export interface NewPerson {
  displayName: string;
  username: string;
  loginType: 'username' | 'email';
  email: string;
  jobRole: string;
  homeNode: string;
}

export async function suggestUsername(displayName: string): Promise<ActionResult<string>> {
  return run('suggest_username', async (tx) => {
    const r = await sql<{ u: string }>`select core.suggest_username(${displayName}) as u`.execute(
      tx,
    );
    return r.rows[0]!.u;
  });
}

export async function previewPerson(p: NewPerson): Promise<ActionResult<PreviewRow[]>> {
  return run('preview_create_user', async (tx) => {
    const r = await sql<PreviewRow>`
      select access_group, node_code, place_name, covers, source, applies
        from core.preview_create_user(${p.username}, ${p.displayName}, ${p.homeNode}::uuid,
                                      ${p.jobRole}, ${p.loginType}, ${p.email || null})`.execute(
      tx,
    );
    return r.rows;
  });
}

export interface Created {
  userId: string;
  username: string;
  /** Username logins only: shown once, never stored. */
  temporaryPassword: string | null;
  pending: number;
}

export async function createPerson(p: NewPerson): Promise<ActionResult<Created>> {
  const created = await run('create_user', async (tx) => {
    const r = await sql<{ r: { user_id: string; pending: string[] } }>`
      select core.create_user(${p.username}, ${p.displayName}, ${p.homeNode}::uuid, ${p.jobRole},
                              ${p.loginType}, ${p.email || null}) as r`.execute(tx);
    return r.rows[0]!.r;
  });
  if (!created.ok) return created;
  const login = await createLogin(created.data.user_id);
  if (!login.ok) return login;
  return {
    ok: true,
    data: {
      userId: created.data.user_id,
      username: p.username.trim().toLowerCase(),
      temporaryPassword: login.data.temporaryPassword,
      pending: created.data.pending.length,
    },
  };
}

/**
 * Creates (or finds) the person's Cognito login and links it. Safe to retry after a
 * Cognito failure: the user row already exists and the login is found, not duplicated.
 */
export async function createLogin(
  userId: string,
): Promise<ActionResult<{ temporaryPassword: string | null }>> {
  const target = await run('login_admin_target', async (tx) => {
    const r = await sql<{ username: string; email: string | null; login_type: string }>`
      select username, email, login_type from core.admin_user(${userId}::uuid)`.execute(tx);
    return r.rows[0]!;
  });
  if (!target.ok) return target;
  const temporaryPassword =
    target.data.login_type === 'username' ? generateTemporaryPassword() : null;
  let sub: string;
  try {
    ({ sub } = await loginDirectory().create({
      username: target.data.username,
      loginType: target.data.login_type as 'username' | 'email',
      email: target.data.email,
      ...(temporaryPassword ? { temporaryPassword } : {}),
    }));
  } catch (err) {
    console.error('cognito create failed', (err as Error).name);
    return failure(new Error('UNEXPECTED'));
  }
  const linked = await run('link_login', (tx) =>
    sql`select core.link_login(${userId}::uuid, ${sub})`.execute(tx),
  );
  if (!linked.ok) return linked;
  return { ok: true, data: { temporaryPassword } };
}

export async function resetPassword(userId: string): Promise<ActionResult<string>> {
  const me = await requireUser();
  if (!(await withinLimit(`reset:${me.id}`, LIMITS.passwordReset))) {
    return failure(new Error('RATE_LIMITED'));
  }
  const target = await run('login_admin_target', async (tx) => {
    const r = await sql<{ username: string }>`
      select username from core.login_admin_target(${userId}::uuid, 'reset_password')`.execute(tx);
    return r.rows[0]!.username;
  });
  if (!target.ok) return target;
  const password = generateTemporaryPassword();
  try {
    await loginDirectory().setTemporaryPassword(target.data, password);
  } catch (err) {
    console.error('cognito password reset failed', (err as Error).name);
    return failure(new Error('UNEXPECTED'));
  }
  return { ok: true, data: password };
}

/**
 * Deactivates a person: the database first (they are cut off on their next request), then
 * the Cognito login is disabled and every session signed out. Retrying is safe.
 */
export async function deactivatePerson(userId: string): Promise<ActionResult> {
  const r = await run('deactivate', async (tx) => {
    await sql`select core.set_user_status(${userId}::uuid, 'inactive')`.execute(tx);
    const t = await sql<{ username: string }>`
      select username from core.login_admin_target(${userId}::uuid, 'disable_login')`.execute(tx);
    return t.rows[0]!.username;
  });
  if (!r.ok) return r;
  try {
    await loginDirectory().disable(r.data);
    await loginDirectory().signOutEverywhere(r.data);
  } catch (err) {
    console.error('cognito disable failed', (err as Error).name);
    return failure(new Error('UNEXPECTED'));
  }
  return { ok: true, data: undefined };
}

export async function reactivatePerson(userId: string): Promise<ActionResult> {
  const r = await run('reactivate', async (tx) => {
    await sql`select core.set_user_status(${userId}::uuid, 'active')`.execute(tx);
    const t = await sql<{ username: string }>`
      select username from core.login_admin_target(${userId}::uuid, 'enable_login')`.execute(tx);
    return t.rows[0]!.username;
  });
  if (!r.ok) return r;
  try {
    await loginDirectory().enable(r.data);
  } catch (err) {
    console.error('cognito enable failed', (err as Error).name);
    return failure(new Error('UNEXPECTED'));
  }
  return { ok: true, data: undefined };
}

export interface PersonChange {
  displayName?: string;
  email?: string;
  jobRole?: string;
  homeNode?: string;
}

export async function updatePerson(
  userId: string,
  c: PersonChange,
): Promise<ActionResult<{ pending: number }>> {
  const r = await run('update_user', async (tx) => {
    const res = await sql<{ r: { pending: string[] }; username: string; login_type: string }>`
      select core.update_user(${userId}::uuid, ${c.displayName || null}, null, ${c.email || null},
                              ${c.jobRole || null}, ${c.homeNode || null}::uuid) as r,
             u.username, u.login_type
        from core.admin_user(${userId}::uuid) u`.execute(tx);
    return res.rows[0]!;
  });
  if (!r.ok) return r;
  if (c.email) {
    try {
      await loginDirectory().setEmail(r.data.username, c.email);
    } catch (err) {
      console.error('cognito email update failed', (err as Error).name);
      return failure(new Error('UNEXPECTED'));
    }
  }
  return { ok: true, data: { pending: r.data.r.pending.length } };
}

export async function previewGrant(
  userId: string,
  group: string,
  node: string,
): Promise<ActionResult<string>> {
  return run('preview_grant', async (tx) => {
    const r = await sql<{ a: string }>`
      select core.preview_grant(${userId}::uuid, ${group}, ${node}::uuid) as a`.execute(tx);
    return r.rows[0]!.a;
  });
}

export interface Grant {
  group: string;
  node: string;
  includeDescendants: boolean;
  from: string;
  to: string;
  reason: string;
  idempotencyKey?: string;
}

export async function grantAccess(
  userId: string,
  g: Grant,
): Promise<ActionResult<{ status: 'applied' | 'pending' }>> {
  return run('grant_access', async (tx) => {
    const r = await sql<{ r: { status: 'applied' | 'pending' } }>`
      select core.grant_access(${userId}::uuid, ${g.group}, ${g.node}::uuid,
                               ${g.includeDescendants}, ${g.from || null}::date,
                               ${g.to || null}::date, ${g.reason || null},
                               ${g.idempotencyKey ?? null}) as r`.execute(tx);
    return { status: r.rows[0]!.r.status };
  });
}

export async function revokeAccess(
  assignmentId: string,
): Promise<ActionResult<{ status: 'applied' | 'pending' }>> {
  return run('revoke_access', async (tx) => {
    const r = await sql<{ r: { status: 'applied' | 'pending' } }>`
      select core.revoke_access(${assignmentId}::uuid) as r`.execute(tx);
    return { status: r.rows[0]!.r.status };
  });
}

// ---------------------------------------------------------------------------
// Modules (ADR 026): the Account Owner turns a module on or off for the whole company.
// core.set_module checks COMPANY_SETTINGS modify at the company; the tenant's audit
// trigger records the change.

export async function setModule(code: string, on: boolean): Promise<ActionResult<null>> {
  const r = await run('set_module', async (tx) => {
    await sql`select core.set_module(${code}, ${on})`.execute(tx);
    return null;
  });
  // every screen's tabs and links follow the modules
  if (r.ok) revalidatePath('/', 'layout');
  return r;
}

// ---------------------------------------------------------------------------
// Company settings (R-4, ADR 031; PO-4, ADR 032): targets, the menu engineering threshold,
// the overtime multiplier, prices on sent orders. core.set_company_settings checks
// COMPANY_SETTINGS modify and every value; the tenant's audit trigger records the change.

export async function saveCompanySettings(settings: unknown): Promise<ActionResult<null>> {
  const r = await run('set_company_settings', async (tx) => {
    await sql`select core.set_company_settings(${JSON.stringify(settings)}::jsonb)`.execute(tx);
    return null;
  });
  // the reports compare against the targets
  if (r.ok) revalidatePath('/reports', 'layout');
  return r;
}

// ---------------------------------------------------------------------------
// The company's own access groups (ADR 027): the Account Owner builds and edits them.
// core.save_custom_group checks COMPANY_SETTINGS modify and every rule (business rights
// only, business roles only, no product codes); the audit triggers record each change.

export interface CustomGroupInput {
  code: string;
  name: string;
  rights: Record<string, 'view' | 'modify'>;
  actsAs: string[];
}

export async function saveCustomGroup(g: CustomGroupInput): Promise<ActionResult<null>> {
  const r = await run('save_custom_group', async (tx) => {
    await sql`select core.save_custom_group(${g.code}, ${g.name}, ${JSON.stringify(g.rights)}::jsonb,
                                            ${g.actsAs}::text[])`.execute(tx);
    return null;
  });
  // the rights of everyone holding it change at once
  if (r.ok) revalidatePath('/', 'layout');
  return r;
}

export async function archiveCustomGroup(code: string): Promise<ActionResult<null>> {
  return run('archive_custom_group', async (tx) => {
    await sql`select core.archive_custom_group(${code})`.execute(tx);
    return null;
  });
}

// ---------------------------------------------------------------------------
// Who does what (ADR 065): who covers a job role at an outlet. core.preview_role_cover runs
// the save and rolls it back, so what the screen says is what Save does; core.set_role_cover
// checks user administration of the outlet, the rules of file 37 and, through
// core.sync_job_role_access, your own access, rank and approvals. Saving the same answer
// again changes nothing, so a repeated tap is harmless.

export type CoverAnswerInput = 'have' | 'covered_by' | 'not_done';

export interface CoverResult {
  changed: boolean;
  applied?: number;
  pending?: number;
  people?: { user_id: string; name: string; waiting: number }[];
  tasks_returned?: number;
  tasks_given?: number;
  tasks_open?: number;
}

export interface CoverPreview {
  errors: { code: string; detail: string | null }[];
  result?: CoverResult;
}

export async function previewRoleCover(
  outlet: string,
  role: string,
  answer: CoverAnswerInput,
  by: string | null,
): Promise<ActionResult<CoverPreview>> {
  return run('preview_role_cover', async (tx) => {
    const r = await sql<{ r: CoverPreview }>`
      select core.preview_role_cover(${outlet}::uuid, ${role}, ${answer}, ${by}) as r`.execute(tx);
    return r.rows[0]!.r;
  });
}

export async function setRoleCover(c: {
  outlet: string;
  role: string;
  answer: CoverAnswerInput;
  by: string | null;
  idempotencyKey?: string;
}): Promise<ActionResult<CoverResult>> {
  const r = await run('set_role_cover', async (tx) => {
    const x = await sql<{ r: CoverResult }>`
      select core.set_role_cover(${c.outlet}::uuid, ${c.role}, ${c.answer}, ${c.by}) as r`.execute(
      tx,
    );
    return x.rows[0]!.r;
  });
  // access and the To do list change with it
  if (r.ok) revalidatePath('/', 'layout');
  return r;
}
