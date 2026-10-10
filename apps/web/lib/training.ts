import 'server-only';
import { sql, type Tx } from './db';

// Training & SOPs (ADR 095): read through ops.* SECURITY DEFINER functions, which check that an
// SOP is the person's, or TRAINING at the place (rule 2).

export interface MySop {
  id: string;
  title: string;
  place: string;
  needs_ack: boolean;
  version: number;
  acked: boolean;
}

export interface SopPage {
  id: string;
  title: string;
  body: string;
  place: string;
  needs_ack: boolean;
  version: number;
  acked_at: string | null;
}

export interface TrainingPlace {
  place_id: string;
  name: string;
  kind: 'outlet' | 'department';
  people: { id: string; name: string }[];
}

export interface Attendance {
  person_id: string;
  name: string;
  attended: boolean;
  score: number | null;
}

export interface TrainingSession {
  id: string;
  title: string;
  starts_at: string;
  trainer: string | null;
  is_test: boolean;
  note: string | null;
  attendance: Attendance[];
}

export interface SopReading {
  sop_id: string;
  title: string;
  version: number;
  people: number;
  acked: number;
  not_yet: string[];
}

export async function mySops(tx: Tx): Promise<MySop[]> {
  return (
    await sql<MySop>`
      select id::text, title, place, needs_ack, version, acked from ops.my_sops()`.execute(tx)
  ).rows;
}

export async function sopPage(tx: Tx, id: string): Promise<SopPage | null> {
  const r = await sql<SopPage>`
    select id::text, title, body, place, needs_ack, version, acked_at::text
      from ops.sop_page(${id}::uuid)`.execute(tx);
  return r.rows[0] ?? null;
}

export async function trainingPlaces(tx: Tx): Promise<TrainingPlace[]> {
  return (
    await sql<TrainingPlace>`
      select place_id::text, name, kind, people from ops.training_places()`.execute(tx)
  ).rows;
}

export async function trainingSessions(tx: Tx, place: string): Promise<TrainingSession[]> {
  return (
    await sql<TrainingSession>`
      select id::text, title, starts_at::text, trainer, is_test, note, attendance
        from ops.training_sessions(${place}::uuid)`.execute(tx)
  ).rows;
}

export async function sopReading(tx: Tx, place: string): Promise<SopReading[]> {
  return (
    await sql<SopReading>`
      select sop_id::text, title, version, people, acked, not_yet
        from ops.sop_reading(${place}::uuid)`.execute(tx)
  ).rows;
}
