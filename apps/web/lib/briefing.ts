import 'server-only';
import { sql, type Tx } from './db';

// Today's briefing note (ADR 069): read through ops.* SECURITY DEFINER functions, which
// decide who may read or write (rule 2). Words and dish names only.

export type BriefingPart = 'day' | 'lunch' | 'dinner';

export const PART_WORDS: Readonly<Record<BriefingPart, string>> = {
  day: 'Whole day',
  lunch: 'Lunch',
  dinner: 'Dinner',
};

/** One note on Home: the outlet's own first, then its departments. */
export interface BriefingNote {
  id: string;
  place_id: string;
  place: string;
  part: BriefingPart;
  body: string;
  off_dishes: { id: string; name: string }[];
  written_by: string | null;
  written_at: string;
  can_edit: boolean;
}

export interface MyBriefing {
  outlet: { id: string; name: string };
  notes: BriefingNote[];
}

export async function myBriefing(tx: Tx): Promise<MyBriefing | null> {
  const r = await sql<BriefingNote & { outlet_id: string; outlet: string }>`
    select outlet_id, outlet, id, place_id, place, part, body, off_dishes, written_by,
           written_at::text, can_edit
      from ops.my_briefing()`.execute(tx);
  const first = r.rows[0];
  if (!first) return null;
  return {
    outlet: { id: first.outlet_id, name: first.outlet },
    notes: r.rows.map(({ outlet_id: _o, outlet: _n, ...n }) => n),
  };
}

export interface BriefingPlace {
  place_id: string;
  place: string;
  kind: 'outlet' | 'department';
  outlet_id: string;
  outlet: string;
}

export async function briefingPlaces(tx: Tx): Promise<BriefingPlace[]> {
  const r = await sql<BriefingPlace>`
    select place_id, place, kind, outlet_id, outlet from ops.briefing_places()`.execute(tx);
  return r.rows;
}

export interface PlaceNote {
  id: string;
  part: BriefingPart;
  body: string;
  off_dishes: string[];
  written_by: string | null;
  written_at: string;
}

export async function briefingAt(tx: Tx, place: string): Promise<PlaceNote[]> {
  const r = await sql<PlaceNote>`
    select id, part, body, off_dishes, written_by, written_at::text
      from ops.briefing_at(${place}::uuid)`.execute(tx);
  return r.rows;
}

export interface Dish {
  id: string;
  name: string;
  menu: string;
}

export async function briefingDishes(tx: Tx, place: string): Promise<Dish[]> {
  const r = await sql<Dish>`
    select id, name, menu from ops.briefing_dishes(${place}::uuid)`.execute(tx);
  return r.rows;
}
