import 'server-only';
import type { Allergen, FoodType } from '@outlet-ops/domain';
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
  /** the batch's production, for its label (ADR 076); null for an opening batch */
  production_id: string | null;
  made_by: string | null;
  food_type: FoodType | null;
  allergens: Allergen[];
  batch_portions: string | null;
}

export async function batches(tx: Tx, store: string): Promise<Batch[]> {
  const r = await sql<Batch>`select * from inv.batches(${store}::uuid)`.execute(tx);
  return r.rows;
}

/** Whether the caller leads the making at a store: records any batch straight from Make and
 * gives out what to make; everyone else makes what they were given (ADR 076). */
export async function leadsMaking(tx: Tx, store: string): Promise<boolean> {
  const r = await sql<{ lead: boolean }>`select inv.leads_making(${store}::uuid) as lead`.execute(
    tx,
  );
  return r.rows[0]?.lead ?? false;
}

export interface MakeTask {
  task_id: string;
  item_id: string;
  name: string;
  unit: string;
  target_qty: string | null;
  due_at: Date;
  overdue: boolean;
}

/** Open prep tasks at a store the caller may work on (theirs, their job role's or shift's). */
export async function myMakeTasks(tx: Tx, store: string): Promise<MakeTask[]> {
  const r = await sql<MakeTask>`select * from inv.my_make_tasks(${store}::uuid)`.execute(tx);
  return r.rows;
}

export interface BatchLabel {
  production_id: string;
  name: string;
  batch_no: string | null;
  made_at: Date;
  expires_at: Date | null;
  qty: string;
  unit: string;
  food_type: FoodType | null;
  allergens: Allergen[];
  batch_portions: string | null;
  made_by: string | null;
  store: string;
  tz: string;
}

/** One batch's FSSAI label (ADR 076), for whoever sees the store's batches or made it. */
export async function batchLabel(tx: Tx, production: string): Promise<BatchLabel | null> {
  const r = await sql<BatchLabel>`select * from inv.batch_label(${production}::uuid)`.execute(tx);
  return r.rows[0] ?? null;
}

export interface PrepRecipe {
  batch_yield: number;
  /** the portions this task's quantity makes (ADR 084), when the item says per batch */
  portions: number | null;
  ingredients: { name: string; category: string | null; qty: number; unit: string }[];
  method: { step: number; instruction: string; minutes: number | null }[];
  batches: { production_id: string; batch_no: string | null; qty: number }[];
}

/** A prep task's ingredients, scaled to what it asks for, and its method (ADR 076). */
export async function prepTaskRecipe(tx: Tx, task: string): Promise<PrepRecipe | null> {
  const r = await sql<{ r: PrepRecipe | null }>`
    select ops.prep_task_recipe(${task}::uuid) as r`.execute(tx);
  return r.rows[0]?.r ?? null;
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
