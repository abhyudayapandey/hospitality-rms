import 'server-only';
import { readDraft, type SetupDraft, type Step } from '@outlet-ops/onboarding/templates';
import { sql, type Tx } from '@/lib/db';

// A set-up draft (ADR 064), read and saved through the platform functions, which check the
// platform admin and keep the audit.

export interface DraftRow {
  id: string;
  name: string;
  choices: unknown;
  step: Step;
  tenant_id: string | null;
  create_job: string | null;
  dry_run_job: string | null;
  apply_job: string | null;
  updated_at: Date;
}

export async function loadDraft(
  tx: Tx,
  id: string,
): Promise<{ row: DraftRow; draft: SetupDraft } | null> {
  const row = (await sql<DraftRow>`select * from platform.setup_draft(${id}::uuid)`.execute(tx))
    .rows[0];
  return row ? { row, draft: readDraft(row.choices) } : null;
}

export async function saveDraft(
  tx: Tx,
  id: string | null,
  draft: SetupDraft,
  step: Step,
): Promise<string> {
  const r = await sql<{ id: string }>`
    select platform.save_setup_draft(${id}::uuid, ${draft.company.name || 'New customer'},
                                     ${JSON.stringify(draft)}::jsonb, ${step}) as id`.execute(tx);
  return r.rows[0]!.id;
}

export interface JobState {
  status: 'queued' | 'running' | 'done' | 'failed';
  tenant_id: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
}

export async function jobState(tx: Tx, id: string | null): Promise<JobState | null> {
  if (!id) return null;
  return (
    (
      await sql<JobState>`select status, tenant_id, error, result from platform.job(${id}::uuid)`.execute(
        tx,
      )
    ).rows[0] ?? null
  );
}
