import 'server-only';
import { daysWords } from '@outlet-ops/domain';
import { sql, type Tx } from './db';

// The licence register and the compliance calendar (ADR 069). Every read is one ops.*
// function that checks COMPLIANCE (or the reminder's task) in SQL; nothing is decided here.

export interface LicenceRow {
  id: string;
  org_node_id: string;
  place_name: string;
  kind: string;
  name: string;
  number: string | null;
  authority: string | null;
  issued_on: string | null;
  expires_on: string | null;
  days_left: number | null;
  renewal_role: string;
  renewal_role_name: string;
  files: string[];
  renewed_from: string | null;
  open_task: string | null;
}

export interface JobRow {
  id: string;
  org_node_id: string;
  place_name: string;
  name: string;
  every_months: number;
  next_due: string;
  days_left: number;
  owner_role: string;
  owner_role_name: string;
  needs_proof: boolean;
  last_done: string | null;
  last_files: string[] | null;
  open_task: string | null;
}

export interface ComplianceCounts {
  licences: number;
  expiring: number;
  items: number;
  overdue: number;
}

export const COMPLIANCE_TABS = ['licences', 'calendar', 'expiring', 'overdue'] as const;
export type ComplianceTab = (typeof COMPLIANCE_TABS)[number];

export function isComplianceTab(s: string | undefined): s is ComplianceTab {
  return (COMPLIANCE_TABS as readonly string[]).includes(s ?? '');
}

// Dates come back as YYYY-MM-DD text (::text), so no time zone moves them.

export async function licences(tx: Tx, node: string | null): Promise<LicenceRow[]> {
  return (
    await sql<LicenceRow>`
      select id, org_node_id, place_name, kind, name, number, authority,
             issued_on::text, expires_on::text, days_left, renewal_role, renewal_role_name,
             files, renewed_from::text, open_task
        from ops.licences(${node}::uuid)`.execute(tx)
  ).rows;
}

export async function complianceJobs(tx: Tx, node: string | null): Promise<JobRow[]> {
  return (
    await sql<JobRow>`
      select id, org_node_id, place_name, name, every_months, next_due::text, days_left,
             owner_role, owner_role_name, needs_proof, last_done::text, last_files, open_task
        from ops.compliance_items(${node}::uuid)`.execute(tx)
  ).rows;
}

export async function complianceCounts(tx: Tx, node: string | null): Promise<ComplianceCounts> {
  const r = await sql<ComplianceCounts>`
    select * from ops.compliance_counts(${node}::uuid)`.execute(tx);
  return r.rows[0] ?? { licences: 0, expiring: 0, items: 0, overdue: 0 };
}

export interface LicenceHistoryRow {
  id: string;
  number: string | null;
  issued_on: string | null;
  expires_on: string | null;
  files: string[];
  archived_at: Date | null;
  archive_reason: string | null;
}

export async function licenceHistory(tx: Tx, id: string): Promise<LicenceHistoryRow[]> {
  return (
    await sql<LicenceHistoryRow>`
      select id, number, issued_on::text, expires_on::text, files, archived_at, archive_reason
        from ops.licence_history(${id}::uuid)`.execute(tx)
  ).rows;
}

export interface JobHistoryRow {
  due_on: string;
  done_on: string;
  done_by: string;
  files: string[];
  note: string | null;
}

export async function jobHistory(tx: Tx, id: string): Promise<JobHistoryRow[]> {
  return (
    await sql<JobHistoryRow>`
      select due_on::text, done_on::text, done_by, files, note
        from ops.compliance_history(${id}::uuid)`.execute(tx)
  ).rows;
}

export interface ComplianceTaskRow {
  licence_id: string | null;
  item_id: string | null;
  name: string;
  place_name: string;
  number: string | null;
  authority: string | null;
  expires_on: string | null;
  next_due: string | null;
  every_months: number | null;
  needs_proof: boolean;
  can_act: boolean;
}

/** What a To do item about a licence or a calendar job points at. */
export async function complianceTask(tx: Tx, task: string): Promise<ComplianceTaskRow | null> {
  return (
    (
      await sql<ComplianceTaskRow>`
        select licence_id, item_id, name, place_name, number, authority, expires_on::text,
               next_due::text, every_months, needs_proof, can_act
          from ops.compliance_task(${task}::uuid)`.execute(tx)
    ).rows[0] ?? null
  );
}

/** A licence's state in words: what it needs, or when it expires. */
export function licenceStatus(l: Pick<LicenceRow, 'number' | 'expires_on' | 'days_left'>): {
  words: string;
  tone: 'ok' | 'soon' | 'late' | 'todo';
} {
  if (!l.number || !l.expires_on || l.days_left === null) {
    return {
      words: !l.number ? 'Add its number and expiry date' : 'No expiry date',
      tone: l.number ? 'ok' : 'todo',
    };
  }
  return {
    words: daysWords(l.days_left, 'Expires'),
    tone: l.days_left < 0 ? 'late' : l.days_left <= 90 ? 'soon' : 'ok',
  };
}

/** A calendar job's state in words. */
export function jobStatus(j: Pick<JobRow, 'days_left'>): {
  words: string;
  tone: 'ok' | 'soon' | 'late';
} {
  return {
    words: daysWords(j.days_left, 'Due'),
    tone: j.days_left < 0 ? 'late' : j.days_left <= 14 ? 'soon' : 'ok',
  };
}

export const TONE_CLASS: Readonly<Record<'ok' | 'soon' | 'late' | 'todo', string>> = {
  ok: 'bg-slate-100 text-slate-700',
  soon: 'bg-amber-100 text-amber-900',
  late: 'bg-rose-100 text-rose-800',
  todo: 'bg-slate-100 text-slate-700',
};

/** "31 Jan 2026" from YYYY-MM-DD. */
export function dayWords(d: string | null): string {
  if (!d) return '';
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
