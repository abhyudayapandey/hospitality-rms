import 'server-only';
import { sql, type Tx } from './db';

// Logbook & handover (ADR 089): read through ops.* SECURITY DEFINER functions, which check
// LOGBOOK at the place (rule 2).

export interface LogbookPlace {
  place_id: string;
  place: string;
  kind: 'outlet' | 'department';
  outlet_id: string;
  outlet: string;
  can_write: boolean;
}

export interface LogEntry {
  id: string;
  kind: 'handover' | 'log';
  body: string;
  written_at: Date;
  written_by: string | null;
  mine: boolean;
  valid_till: Date | null;
  to_place: string | null;
  to_who: string | null;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  task_id: string | null;
  can_take_down: boolean;
}

export interface LogbookTargets {
  places: { id: string; name: string }[];
  people: { id: string; name: string; role: string; role_name: string | null; place_id: string }[];
}

export async function logbookPlaces(tx: Tx): Promise<LogbookPlace[]> {
  return (await sql<LogbookPlace>`select * from ops.logbook_places()`.execute(tx)).rows;
}

export async function logbook(tx: Tx, place: string): Promise<LogEntry[]> {
  return (await sql<LogEntry>`select * from ops.logbook(${place}::uuid)`.execute(tx)).rows;
}

export async function logbookTargets(tx: Tx, place: string): Promise<LogbookTargets> {
  const r = await sql<{
    t: LogbookTargets;
  }>`select ops.logbook_targets(${place}::uuid) as t`.execute(tx);
  return r.rows[0]!.t;
}
