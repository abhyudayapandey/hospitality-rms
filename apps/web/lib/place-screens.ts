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
  // reports (ADR 023, 028): rpt.report_places(), not core.screen_places()
  'outlet_flash',
  'department',
  'cost_of_sales',
  'menu_engineering',
  'stock_position',
  'purchasing',
  'central_kitchen',
  'people',
] as const;

/** Report screens: their places come from rpt.report_places(). */
export const REPORT_SCREENS = [
  'outlet_flash',
  'department',
  'cost_of_sales',
  'menu_engineering',
  'stock_position',
  'purchasing',
  'central_kitchen',
  'people',
] as const;
export type ReportScreen = (typeof REPORT_SCREENS)[number];

export function isReportScreen(s: string): s is ReportScreen {
  return (REPORT_SCREENS as readonly string[]).includes(s);
}

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

export interface NamedPlace {
  id: string;
  name: string;
  /** org or supply kind: outlet, site, department, store, … */
  kind?: string;
}

export interface PlaceGroup {
  /** the outlet or site the options belong to; null when there is only one */
  label: string | null;
  options: { id: string; name: string; short: string }[];
}

/**
 * Places grouped by outlet, named without the outlet (UX review U-5): "Test Hotel & Bar
 * 1.0 – Kitchen Store" shows as "Kitchen Store" under "Test Hotel & Bar 1.0". A place named
 * after its outlet is the whole outlet or site. Names without " – " stay as they are.
 */
export function groupPlaces(places: readonly NamedPlace[]): PlaceGroup[] {
  const groups = new Map<string, PlaceGroup['options']>();
  for (const p of places) {
    const cut = p.name.indexOf(' – ');
    const outlet = cut > 0 ? p.name.slice(0, cut) : p.name;
    const short =
      cut > 0
        ? p.name.slice(cut + 3)
        : p.kind === 'site'
          ? 'Whole site'
          : p.kind === 'outlet'
            ? 'Whole outlet'
            : p.name;
    const list = groups.get(outlet) ?? [];
    list.push({ id: p.id, name: p.name, short });
    groups.set(outlet, list);
  }
  const all = [...groups.entries()];
  // one outlet: no headings needed; a place standing alone keeps its full name
  if (all.length === 1) return [{ label: null, options: all[0]![1] }];
  return all.map(([label, options]) =>
    options.length === 1 && options[0]!.name === label
      ? { label: null, options: [{ ...options[0]!, short: label }] }
      : { label, options },
  );
}
