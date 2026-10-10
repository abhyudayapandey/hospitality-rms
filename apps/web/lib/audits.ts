import 'server-only';
import { sql, type Tx } from './db';

// Audits & taste panels (ADR 095): read through ops.* SECURITY DEFINER functions, which check
// AUDITS at the place (rule 2).

export interface AuditPlace {
  place_id: string;
  name: string;
  audits: number;
}

export interface AuditRound {
  template_id: string;
  audit: string;
  task_id: string | null;
  done_at: string | null;
  done_by: string | null;
  score: string | null;
}

export async function auditPlaces(tx: Tx): Promise<AuditPlace[]> {
  return (
    await sql<AuditPlace>`select place_id::text, name, audits from ops.audit_places()`.execute(tx)
  ).rows;
}

export async function auditRounds(tx: Tx, place: string): Promise<AuditRound[]> {
  return (
    await sql<AuditRound>`
      select template_id::text, audit, task_id::text, done_at::text, done_by, score::text
        from ops.audit_rounds(${place}::uuid)`.execute(tx)
  ).rows;
}
