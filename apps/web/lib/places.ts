import 'server-only';
import { cookies } from 'next/headers';
import { PLACE_COOKIE } from './auth/session';
import { sql, withUser, type Tx } from './db';
import { param, type SearchParams } from './params';
import { PLACE_SCREENS, type Screen } from './place-screens';
import { loadShell, type NodeRow, type Shell } from './shell';

// The "Viewing:" switcher (ADR 016). Each screen lists only its own kind of place, from
// core.screen_places(screen), which checks every place with core.can(). The place shown
// is ?node= when it is one of them, else the person's last choice on that screen (one
// cookie, a small JSON map), else the most useful place the function puts first.

export { PLACE_SCREENS, type Screen };

export interface Place extends NodeRow {
  code: string;
  preferred: number;
}

export async function screenPlaces(tx: Tx, screen: Screen, shell: Shell): Promise<Place[]> {
  const r = await sql<{
    id: string;
    code: string;
    name: string;
    kind: string;
    type: 'org' | 'delivery';
    timezone: string | null;
    preferred: number;
  }>`select id, code, name, kind, type, timezone, preferred
       from core.screen_places(${screen})`.execute(tx);
  const known = new Map(shell.nodes.map((n) => [n.id, n]));
  return r.rows.map((p) => {
    const n = known.get(p.id);
    return {
      ...p,
      depth: n?.depth ?? 0,
      derived: n?.derived ?? false,
      timezone: p.timezone ?? n?.timezone ?? null,
      holds_stock: n?.holds_stock ?? p.type === 'delivery',
    };
  });
}

/** The person's remembered place per screen (validated against the list before use). */
export async function rememberedPlaces(): Promise<Partial<Record<Screen, string>>> {
  const raw = (await cookies()).get(PLACE_COOKIE)?.value;
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return {};
    return Object.fromEntries(
      Object.entries(v).filter(
        ([k, id]) => PLACE_SCREENS.includes(k as Screen) && typeof id === 'string',
      ),
    );
  } catch {
    return {};
  }
}

/** ?node= if it is one of the places, else the remembered one, else the first. */
export async function pickPlace<P extends { id: string }>(
  screen: Screen,
  places: P[],
  sp: SearchParams,
): Promise<P | null> {
  const wanted = param(await sp, 'node');
  const remembered = (await rememberedPlaces())[screen];
  return (
    places.find((p) => p.id === wanted) ??
    places.find((p) => p.id === remembered) ??
    places[0] ??
    null
  );
}

export interface PlaceContext {
  shell: Shell;
  places: Place[];
  place: Place | null;
}

/** A screen's places and the one to show, for screens outside the supply tabs. */
export async function placesFor(screen: Screen, sp: SearchParams): Promise<PlaceContext> {
  const shell = await loadShell();
  const places = await withUser(shell.user.id, (tx) => screenPlaces(tx, screen, shell));
  return { shell, places, place: await pickPlace(screen, places, sp) };
}
