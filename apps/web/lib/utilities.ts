import 'server-only';
import { sql, type Tx } from './db';

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

export async function utilityDays(tx: Tx, place: string, days: number): Promise<UtilityDay[]> {
  return (
    await sql<UtilityDay>`
      select meter_id, meter, kind, unit, day::text, reading::text, used::text
        from ops.utility_days(${place}::uuid, rpt.today(${place}::uuid) - ${days - 1}::int,
                              rpt.today(${place}::uuid))`.execute(tx)
  ).rows;
}

export async function utilityMonths(tx: Tx, place: string): Promise<UtilityMonth[]> {
  return (
    await sql<UtilityMonth>`
      select meter_id, meter, unit, month::text, used::text
        from ops.utility_months(${place}::uuid)`.execute(tx)
  ).rows;
}
