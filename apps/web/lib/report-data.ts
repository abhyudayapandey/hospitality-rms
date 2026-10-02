import 'server-only';
import { sql, type Tx } from './db';
import { pickPlace } from './places';
import type { SearchParams } from './params';
import { param } from './params';
import type { ReportScreen } from './place-screens';
import { isIsoDate } from './dates';
import type { MeasureRow, ReportCode } from './reports';

// Reads for the reports (ADR 023). Every rpt.* function checks core.can() at the place it
// is asked about and refuses otherwise (NOT_AUTHORISED); nothing here decides access.

export interface ReportPlace {
  id: string;
  code: string;
  name: string;
  kind: string;
  preferred: number;
}

export async function myReports(tx: Tx): Promise<ReportCode[]> {
  const r = await sql<{ report: ReportCode }>`select report from rpt.my_reports()`.execute(tx);
  return r.rows.map((x) => x.report);
}

export async function reportPlaces(tx: Tx, report: ReportScreen): Promise<ReportPlace[]> {
  const r = await sql<ReportPlace>`
    select id, code, name, kind, preferred from rpt.report_places(${report})`.execute(tx);
  return r.rows;
}

/** Today's business day at a place (06:00 to 06:00 local). */
export async function reportToday(tx: Tx, node: string): Promise<string> {
  const r = await sql<{ d: string }>`select rpt.today(${node}::uuid)::text as d`.execute(tx);
  return r.rows[0]!.d;
}

export async function outletFlash(tx: Tx, node: string, day: string): Promise<MeasureRow[]> {
  const r = await sql<MeasureRow>`
    select measure, value::text, last_week::text
      from rpt.outlet_flash(${node}::uuid, ${day}::date)`.execute(tx);
  return r.rows;
}

export async function departmentDay(tx: Tx, node: string, day: string): Promise<MeasureRow[]> {
  const r = await sql<MeasureRow>`
    select measure, value::text, last_week::text
      from rpt.department_day(${node}::uuid, ${day}::date)`.execute(tx);
  return r.rows;
}

export interface OnShift {
  name: string;
  role_code: string;
  start_at: string;
  end_at: string;
  clocked_in_at: string | null;
  clocked_out_at: string | null;
}

export async function departmentPeople(tx: Tx, node: string): Promise<OnShift[]> {
  const r = await sql<OnShift>`
    select name, role_code, start_at::text, end_at::text, clocked_in_at::text,
           clocked_out_at::text
      from rpt.department_people(${node}::uuid)`.execute(tx);
  return r.rows;
}

export async function myWeek(tx: Tx, monday: string): Promise<MeasureRow[]> {
  const r = await sql<MeasureRow>`
    select measure, value::text from rpt.my_week(${monday}::date)`.execute(tx);
  return r.rows;
}

/** The place a report shows (?node=, else the remembered one, else the person's own). */
export async function reportPlace(
  tx: Tx,
  report: ReportScreen,
  sp: SearchParams,
): Promise<{ places: ReportPlace[]; place: ReportPlace | null }> {
  const places = await reportPlaces(tx, report);
  return { places, place: await pickPlace(report, places, sp) };
}

/** The day asked for (?day=), else today; never after today. */
export async function reportDay(sp: SearchParams, today: string): Promise<string> {
  const asked = param(await sp, 'day');
  return isIsoDate(asked) && asked <= today ? asked : today;
}
