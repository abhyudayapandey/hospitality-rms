import 'server-only';
import { sql, type Tx } from './db';

// Reads for the menu, recipe and procedure screens (ADR 014). Recipes come through
// inv.my_recipes / inv.recipe_card (the same rule as the recipe policies, never a cost);
// costs and prices only through functions that check MENU view at the store.

export interface RecipeRow {
  recipe_id: string;
  kind: 'prep' | 'menu';
  subject_id: string;
  code: string;
  name: string;
  grp: string;
  unit: string | null;
  batch_yield: string | null;
  shelf_life_hours: number | null;
  version: number;
  effective_from: string;
}

export async function myRecipes(tx: Tx): Promise<RecipeRow[]> {
  const r = await sql<RecipeRow>`
    select recipe_id, kind, subject_id, code, name, grp, unit, batch_yield, shelf_life_hours,
           version, effective_from::text
      from inv.my_recipes()`.execute(tx);
  return r.rows;
}

export interface CardLine {
  line_no: number;
  ingredient_id: string;
  code: string;
  name: string;
  kind: 'raw' | 'prep';
  qty: string;
  unit: string;
  trim_loss_pct: string;
}

export async function recipeCard(tx: Tx, recipe: string): Promise<CardLine[]> {
  const r = await sql<CardLine>`select * from inv.recipe_card(${recipe}::uuid)`.execute(tx);
  return r.rows;
}

export interface Step {
  step: number;
  instruction: string;
  minutes: number | null;
}

export async function procedure(tx: Tx, prepItem: string): Promise<Step[]> {
  const r = await sql<Step>`
    select step, instruction, minutes from inv.prep_procedure
     where prep_item_id = ${prepItem}::uuid order by step`.execute(tx);
  return r.rows;
}

export interface MenuPlace {
  outlet_id: string;
  outlet_name: string;
  store_id: string;
  store_name: string;
  can_edit: boolean;
}

export async function menuPlaces(tx: Tx): Promise<MenuPlace[]> {
  const r = await sql<MenuPlace>`select * from menu.my_menu_places()`.execute(tx);
  return r.rows;
}

export interface CostRow {
  menu_item_id: string;
  code: string;
  name: string;
  menu: 'Food' | 'Bar';
  category: string;
  store_id: string;
  store_name: string;
  price: string;
  currency: string;
  cost_per_serve: string | null;
  cost_pct: string | null;
}

export async function outletCosting(tx: Tx, outlet: string): Promise<CostRow[]> {
  const r = await sql<CostRow>`
    select menu_item_id, code, name, menu, category, store_id, store_name, price, currency,
           cost_per_serve, cost_pct
      from menu.outlet_costing(${outlet}::uuid)`.execute(tx);
  return r.rows;
}

export interface LineCost {
  line_no: number;
  unit_cost: string | null;
  line_cost: string | null;
}

export async function lineCosts(tx: Tx, recipe: string, store: string): Promise<LineCost[]> {
  const r = await sql<LineCost>`
    select line_no, unit_cost, line_cost from inv.recipe_line_costs(${recipe}::uuid, ${store}::uuid)`.execute(
    tx,
  );
  return r.rows;
}

export interface IngredientOption {
  item_id: string;
  code: string;
  name: string;
  kind: 'raw' | 'prep';
  unit: string;
}

export async function ingredientOptions(tx: Tx): Promise<IngredientOption[]> {
  const r = await sql<IngredientOption>`select * from inv.recipe_ingredients()`.execute(tx);
  return r.rows;
}

/** A cost % worth a second look on a menu (food above 35 %, bar above 30 %). */
export function highCost(menu: string, pct: string | null): boolean {
  return pct !== null && Number(pct) > (menu === 'Bar' ? 30 : 35);
}

export function shelfLife(hours: number | null): string {
  if (hours === null) return '';
  return hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hours`;
}
