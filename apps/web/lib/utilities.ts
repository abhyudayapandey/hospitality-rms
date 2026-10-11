import 'server-only';
import { sql, type Tx } from './db';
import type { DateRange } from './date-range';

// Utilities (ADR 091): read through ops.* SECURITY DEFINER functions, which check UTILITIES at
// the meter's place (rule 2).

export interface UtilityPlace {
  place_id: string;
  name: string;
  meters: number;
}

export interface UtilityDay {
  meter_id: string;
  meter: string;
  kind: string;
  unit: string;
  day: string;
  reading: string;
  used: string | null;
}

export interface UtilityMeter {
  meter_id: string;
  meter: string;
  kind: string;
  unit: string;
  read_by: string | null;
  read_at: string | null;
  last_read_at: string | null;
  last_reading: string | null;
}

export interface UtilityMonth {
  meter_id: string;
  meter: string;
  unit: string;
  month: string;
  used: string | null;
}

export async function utilityPlaces(tx: Tx): Promise<UtilityPlace[]> {
  return (await sql<UtilityPlace>`select * from ops.utility_places()`.execute(tx)).rows;
}

/** Every meter of the place, read yet or not, with who reads it and its last reading (ADR 097). */
export async function utilityMeters(tx: Tx, place: string): Promise<UtilityMeter[]> {
  return (
    await sql<UtilityMeter>`
      select meter_id, meter, kind, unit, read_by, read_at, last_read_at::text,
             last_reading::text
        from ops.utility_meters(${place}::uuid)`.execute(tx)
  ).rows;
}

export async function utilityDays(
  tx: Tx,
  place: string,
  days: number,
  /** these days instead of the last `days` (ADR 120) */
  range: DateRange | null = null,
): Promise<UtilityDay[]> {
  const from = range ? sql`${range.from}::date` : sql`rpt.today(${place}::uuid) - ${days - 1}::int`;
  const to = range ? sql`${range.to}::date` : sql`rpt.today(${place}::uuid)`;
  return (
    await sql<UtilityDay>`
      select meter_id, meter, kind, unit, day::text, reading::text, used::text
        from ops.utility_days(${place}::uuid, ${from}, ${to})`.execute(tx)
  ).rows;
}

export async function utilityMonths(tx: Tx, place: string): Promise<UtilityMonth[]> {
  return (
    await sql<UtilityMonth>`
      select meter_id, meter, unit, month::text, used::text
        from ops.utility_months(${place}::uuid)`.execute(tx)
  ).rows;
}

export interface UtilityReading {
  meter_id: string;
  read_at: string;
  day: string;
  /** HH:MM where the meter is */
  read_time: string;
  value: string;
  /** since the reading before; null for a meter's first */
  used: string | null;
  /** when its round was due, HH:MM; null for a reading not from a round */
  due_time: string | null;
  /** taken more than 30 minutes before or after it was due (ADR 124) */
  off_time: boolean;
  read_by: string | null;
}

/** Every reading of the place's meters on these days, newest first, with its time (ADR 124). */
export async function utilityReadings(
  tx: Tx,
  place: string,
  days: number,
  range: DateRange | null = null,
): Promise<UtilityReading[]> {
  const from = range ? sql`${range.from}::date` : sql`rpt.today(${place}::uuid) - ${days - 1}::int`;
  const to = range ? sql`${range.to}::date` : sql`rpt.today(${place}::uuid)`;
  return (
    await sql<UtilityReading>`
      select meter_id, read_at::text, day::text, read_time, value::text, used::text, due_time, off_time,
             read_by
        from ops.utility_readings(${place}::uuid, ${from}, ${to})`.execute(tx)
  ).rows;
}
