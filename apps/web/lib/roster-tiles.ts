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
}

export interface RosterDay {
  types: ShiftType[];
  people: TilePerson[];
}

export async function rosterDay(tx: Tx, node: string, day: string): Promise<RosterDay> {
  const r = await sql<{ d: RosterDay }>`
    select hr.roster_day(${node}::uuid, ${day}::date) as d`.execute(tx);
  return r.rows[0]!.d;
}
