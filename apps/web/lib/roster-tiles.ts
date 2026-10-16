import 'server-only';
import { sql, type Tx } from './db';

// A department's people and shift types for one day, for the roster's tiles (ADR 082).

export interface ShiftType {
  template_id: string;
  name: string;
  role_code: string;
  shift_type: 'straight' | 'split' | 'panzer';
  start: string;
  end: string;
  first_end: string | null;
  second_start: string | null;
  break_minutes: number;
  /** the template runs on this weekday */
  runs: boolean;
}

export interface TilePerson {
  worker_id: string;
  name: string;
  role_code: string;
  job_role: string | null;
  /** the shift type they are on that day; null: off, or a shift added by hand */
  template_id: string | null;
  /** the shift they are on that day, with or without a shift type; null: off */
  shift_id: string | null;
  shift_name: string | null;
  /** its times where the department is, HH:MM */
  start: string | null;
  end: string | null;
  status: 'draft' | 'published' | null;
  /** a change to their day not yet published (ADR 135) */
  changed: boolean;
  /** their leave that day, approved or asked for (ADR 163) */
  leave_id?: string | null;
  leave_status?: 'approved' | 'submitted' | null;
}

export interface RosterDay {
  types: ShiftType[];
  people: TilePerson[];
}

export async function rosterDay(tx: Tx, node: string, day: string): Promise<RosterDay> {
  const r = await sql<{ d: RosterDay }>`
    select hr.roster_day(${node}::uuid, ${day}::date) as d`.execute(tx);
  const d = r.rows[0]!.d;
  // who is on leave, or has asked for it, that day (ADR 163)
  const leave = (
    await sql<{ worker_id: string; leave_id: string; status: 'approved' | 'submitted' }>`
      select worker_id::text, leave_id::text, status
        from hr.leave_for_day(${node}::uuid, ${day}::date)`.execute(tx)
  ).rows;
  const of = new Map(leave.map((l) => [l.worker_id, l]));
  return {
    ...d,
    people: d.people.map((p) => ({
      ...p,
      leave_id: of.get(p.worker_id)?.leave_id ?? null,
      leave_status: of.get(p.worker_id)?.status ?? null,
    })),
  };
}
