import 'server-only';
import { sql, type Tx } from './db';

// Reads for the production, sales and variance screens (ADR 015). Each function checks the
// access of the write it prepares (PRODUCTION, SALES) or MENU view for costs.

export interface MadeHere {
  item_id: string;
  sku: string;
  name: string;
  unit: string;
  batch_yield: string;
}

export async function madeHere(tx: Tx, store: string): Promise<MadeHere[]> {
  const r = await sql<MadeHere>`select * from inv.made_here(${store}::uuid)`.execute(tx);
  return r.rows;
}

export interface PlanLine {
  line_no: number;
  ingredient_id: string;
  name: string;
  qty: string;
  unit: string;
  batch_yield: string;
  batch_unit: string;
  shelf_life_hours: number;
}

export async function productionPlan(tx: Tx, store: string, prep: string): Promise<PlanLine[]> {
  const r =
    await sql<PlanLine>`select * from inv.production_plan(${store}::uuid, ${prep}::uuid)`.execute(
      tx,
    );
  return r.rows;
}

export interface Batch {
  item_id: string;
  sku: string;
  name: string;
  unit: string;
  batch_no: string | null;
  made_at: Date;
  expires_at: Date;
  qty: string;
  remaining: string;
  expired: boolean;
}

export async function batches(tx: Tx, store: string): Promise<Batch[]> {
  const r = await sql<Batch>`select * from inv.batches(${store}::uuid)`.execute(tx);
  return r.rows;
}

export interface SalesPlace {
  outlet_id: string;
  outlet_name: string;
}

export async function salesPlaces(tx: Tx): Promise<SalesPlace[]> {
  const r = await sql<SalesPlace>`select * from menu.my_sales_places()`.execute(tx);
  return r.rows;
}

export interface SheetRow {
  menu_item_id: string;
  code: string;
  name: string;
  menu: string;
  category: string;
  store_id: string;
  posted_qty: string | null;
}

export async function salesSheet(tx: Tx, outlet: string, date: string): Promise<SheetRow[]> {
  const r = await sql<SheetRow>`
    select * from menu.sales_sheet(${outlet}::uuid, ${date}::date)`.execute(tx);
  return r.rows;
}

export interface VarianceRow {
  item_id: string;
  sku: string;
  name: string;
  unit: string;
  opening: string;
  receipts: string;
  transfers_in: string;
  transfers_out: string;
  wastage: string;
  production_in: string;
  production_out: string;
  sales_use: string;
  other_use: string;
  expected_closing: string;
  variance_qty: string;
  variance_value: string;
  closing: string;
  counted: boolean;
  pending_qty: string;
  unexplained: boolean;
}

export async function variance(
  tx: Tx,
  store: string,
  from: string,
  to: string,
): Promise<VarianceRow[]> {
  const r = await sql<VarianceRow>`
    select * from inv.variance(${store}::uuid, ${from}::date, ${to}::date)`.execute(tx);
  return r.rows;
}

export interface CostRow {
  menu: string;
  revenue: string;
  theoretical_cost: string;
  theoretical_pct: string | null;
  actual_cost: string;
  actual_pct: string | null;
}

export async function costReport(
  tx: Tx,
  outlet: string,
  from: string,
  to: string,
): Promise<CostRow[]> {
  const r = await sql<CostRow>`
    select * from menu.cost_report(${outlet}::uuid, ${from}::date, ${to}::date)`.execute(tx);
  return r.rows;
}

/** A date like 2026-10-01 from user input, else the fallback. */
export function isoDate(v: string, fallback: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;
}

/** Today's date in India (the test customers' and pilot's time zone). */
export function todayIn(tz = 'Asia/Kolkata', offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
}
