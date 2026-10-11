import 'server-only';
import { sql, type Tx } from './db';

// The shift handover (ADR 118): the last round of each handover checklist of a department I
// work in, finished by someone else in the last 24 hours, until I tap "Seen". Read through
// ops.last_handovers (SECURITY DEFINER; it decides whose they are).

export interface HandoverStep {
  label: string;
  kind: string;
  num: number | null;
  text: string | null;
  unit: string | null;
  done: boolean;
  flagged: boolean;
}

export interface LastHandover {
  task_id: string;
  place: string;
  title: string;
  done_by: string | null;
  done_at: Date;
  note: string | null;
  steps: HandoverStep[];
}

export async function lastHandovers(tx: Tx): Promise<LastHandover[]> {
  return (
    await sql<LastHandover>`select task_id::text, place, title, done_by, done_at, note, steps
                              from ops.last_handovers()`.execute(tx)
  ).rows;
}

/** A step's answer in words: ✓ for a tick, the number with its unit, the text, a yes or no. */
export function handoverAnswer(s: HandoverStep): string {
  if (!s.done) return 'not done';
  if (s.kind === 'number' && s.num !== null) return `${s.num}${s.unit ? ` ${s.unit}` : ''}`;
  if (s.text) return s.text;
  if (s.kind === 'rating' && s.num !== null) return `${s.num} of 5`;
  return '✓';
}
