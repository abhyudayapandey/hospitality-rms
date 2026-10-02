// The screens that show one place at a time, as core.screen_places() names them (ADR 016).
// Shared by the server (lib/places.ts) and the switcher in the browser.

export const PLACE_SCREENS = [
  'stock',
  'count',
  'wastage',
  'orders',
  'transfers',
  'variance',
  'production',
  'sales',
  'menu',
  'roster',
  'exceptions',
  'events',
  // tasks (ADR 020): team places and outlets
  'tasks',
  'tasks_new',
  'checklists',
  'maintenance',
  'report',
] as const;

export type Screen = (typeof PLACE_SCREENS)[number];

export function isScreen(s: string): s is Screen {
  return (PLACE_SCREENS as readonly string[]).includes(s);
}

/** The remembered-place map with one screen's choice replaced (the cookie's value). */
export function withChoice(
  current: Partial<Record<Screen, string>>,
  screen: Screen,
  id: string,
): string {
  return JSON.stringify({ ...current, [screen]: id });
}
