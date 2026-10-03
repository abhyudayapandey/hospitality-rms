import 'server-only';
import { sql, type Tx } from './db';
import { pickPlace } from './places';
import type { SearchParams } from './params';
import { param } from './params';
import type { ReportScreen } from './place-screens';
import { isIsoDate } from './dates';
import { periodRange, type CostItem, type MeasureRow, type ReportCode } from './reports';
import { SALES_MEASURES } from './modules';

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

/** The outlet's day; without Menu and sales (ADR 026) the figures from sales are left out. */
export async function outletFlash(tx: Tx, node: string, day: string): Promise<MeasureRow[]> {
  const r = await sql<MeasureRow & { sales_on: boolean }>`
    select measure, value::text, last_week::text,
           (select "on" from core.my_modules() where code = 'menu_sales') as sales_on
      from rpt.outlet_flash(${node}::uuid, ${day}::date)`.execute(tx);
  return r.rows
    .filter((x) => x.sales_on || !SALES_MEASURES.has(x.measure))
    .map(({ sales_on: _, ...row }) => row);
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

// ---------------------------------------------------------------------------------------
// The cost controller's reports (R-2, ADR 028)
// ---------------------------------------------------------------------------------------

export async function costTotals(
  tx: Tx,
  place: string,
  from: string,
  to: string,
): Promise<MeasureRow[]> {
  const r = await sql<MeasureRow>`
    select measure, value::text from rpt.cost_totals(${place}::uuid, ${from}::date, ${to}::date)
  `.execute(tx);
  return r.rows;
}

export interface CostItemRow extends CostItem {
  store_id: string;
  opening: string;
  came_in: string;
  went_out: string;
  used: string;
  expected_closing: string;
  pending_qty: string;
}

export async function costItems(
  tx: Tx,
  place: string,
  from: string,
  to: string,
): Promise<CostItemRow[]> {
  const r = await sql<CostItemRow>`
    select store_id, store_name, sku, name, unit, opening::text, came_in::text,
           went_out::text, used::text, expected_closing::text, variance_qty::text,
           variance_value::text, counted, pending_qty::text, unexplained
      from rpt.cost_items(${place}::uuid, ${from}::date, ${to}::date)`.execute(tx);
  return r.rows;
}

export interface ExpiredRow {
  store_name: string;
  name: string;
  unit: string;
  batch_no: string | null;
  made_qty: string | null;
  wasted_qty: string;
  value: string;
  outcome: string;
  reported_by: string | null;
  discarded_by: string | null;
  remade_qty: string | null;
}

export async function costExpired(
  tx: Tx,
  place: string,
  from: string,
  to: string,
): Promise<ExpiredRow[]> {
  const r = await sql<ExpiredRow>`
    select store_name, name, unit, batch_no, made_qty::text, wasted_qty::text, value::text,
           outcome, reported_by, discarded_by, remade_qty::text
      from rpt.cost_expired(${place}::uuid, ${from}::date, ${to}::date)`.execute(tx);
  return r.rows;
}

export interface DishRow {
  menu: string;
  code: string;
  name: string;
  sold: string;
  price: string | null;
  cost: string | null;
  margin: string | null;
  mix_pct: string | null;
  avg_margin: string | null;
  popular_from_pct: string | null;
  class: string | null;
}

export async function menuEngineering(
  tx: Tx,
  outlet: string,
  from: string,
  to: string,
): Promise<DishRow[]> {
  const r = await sql<DishRow>`
    select menu, code, name, sold::text, price::text, cost::text, margin::text, mix_pct::text,
           avg_margin::text, popular_from_pct::text, class
      from rpt.menu_engineering(${outlet}::uuid, ${from}::date, ${to}::date)`.execute(tx);
  return r.rows;
}

export async function stockSummary(tx: Tx, store: string): Promise<MeasureRow[]> {
  const r = await sql<MeasureRow>`
    select measure, value::text from rpt.stock_summary(${store}::uuid)`.execute(tx);
  return r.rows;
}

export interface StockItemRow {
  sku: string;
  name: string;
  category: string;
  unit: string;
  on_hand: string;
  value: string;
  days_on_hand: string | null;
  last_moved_at: string | null;
  dead: boolean;
}

export async function stockItems(tx: Tx, store: string): Promise<StockItemRow[]> {
  const r = await sql<StockItemRow>`
    select sku, name, category, unit, on_hand::text, value::text, days_on_hand::text,
           last_moved_at::text, dead
      from rpt.stock_items(${store}::uuid)`.execute(tx);
  return r.rows;
}

export interface PriceChangeRow {
  sku: string;
  name: string;
  unit: string;
  supplier: string;
  received_at: string;
  qty: string;
  unit_cost: string;
  previous_cost: string | null;
  basis: 'previous' | 'standard';
  change_value: string | null;
}

export async function priceChanges(
  tx: Tx,
  store: string,
  from: string,
  to: string,
): Promise<PriceChangeRow[]> {
  const r = await sql<PriceChangeRow>`
    select sku, name, unit, supplier, received_at::text, qty::text, unit_cost::text,
           previous_cost::text, basis, change_value::text
      from rpt.price_changes(${store}::uuid, ${from}::date, ${to}::date)`.execute(tx);
  return r.rows;
}

export interface SupplierFillRow {
  supplier: string;
  orders: number;
  ordered_value: string;
  received_value: string;
  fill_pct: string | null;
  on_time: number;
  late: number;
  not_delivered: number;
  not_due: number;
}

export async function supplierFill(
  tx: Tx,
  store: string,
  from: string,
  to: string,
): Promise<SupplierFillRow[]> {
  const r = await sql<SupplierFillRow>`
    select supplier, orders, ordered_value::text, received_value::text, fill_pct::text,
           on_time, late, not_delivered, not_due
      from rpt.supplier_fill(${store}::uuid, ${from}::date, ${to}::date)`.execute(tx);
  return r.rows;
}

export interface ShortRow {
  supplier: string;
  name: string;
  unit: string;
  released_on: string;
  due_on: string;
  ordered: string;
  received: string;
  short_value: string;
}

export async function shortDeliveries(
  tx: Tx,
  store: string,
  from: string,
  to: string,
): Promise<ShortRow[]> {
  const r = await sql<ShortRow>`
    select supplier, name, unit, released_on::text, due_on::text, ordered::text,
           received::text, short_value::text
      from rpt.short_deliveries(${store}::uuid, ${from}::date, ${to}::date)`.execute(tx);
  return r.rows;
}

/** The period asked for (?period=, ?from=, ?to=), ending today at the latest. */
export async function reportPeriod(sp: SearchParams, today: string) {
  const p = await sp;
  return periodRange(param(p, 'period'), today, param(p, 'from'), param(p, 'to'));
}
