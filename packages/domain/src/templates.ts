// Outlet templates (ADR 062): what an outlet of each SOP format starts with — its departments,
// the stores they keep, the roles it expects, the modules it needs and its starter checklists
// and items. Product code, like the duties and the catalogue. The sales and onboarding teams
// never see a code: they pick a tile ("Restaurant + Bar") and tick what else is there, and
// the template is turned into the customer's onboarding files, then dry run and applied.
//
// A department, role, checklist or starter item marked for a view (`cafe` / `restaurant`) is
// on, and listed first, in that view only; one with no view is on in both. A role is on when
// its department is (a role that works at the outlet is always on).

import { CHECKLIST_BY_CODE } from './checklists';
import { DEPARTMENTS, ROLE_BY_CODE, type RoleDef } from './catalogue';
import { OUTLET_FORMATS, type OutletFormat } from './formats';
import type { ModuleCode } from './modules';

export type View = 'cafe' | 'restaurant';

export interface TemplateDepartment {
  /** A catalogue department (`KITCHEN`). */
  code: string;
  /** On by default; off ones are offered, unticked. */
  on?: boolean;
  view?: View;
  /** A word beside its tick box when it holds more than its name says. */
  note?: string;
}

export interface TemplateRole {
  code: string;
  /** The template department it belongs to, when not its catalogue home. */
  department?: string;
  view?: View;
}

export interface TemplateChecklist {
  /** A library checklist (`CHILLER-LOG`). */
  code: string;
  /** The department it goes in, when not the library's. */
  department?: string;
  view?: View;
}

export interface StarterItem {
  code: string;
  name: string;
  category: string;
  unit: string;
  perishable: boolean;
  /** The department whose store keeps it (the Main Store, for STORES-TEAM). */
  department: string;
  view?: View;
}

export interface OutletTemplate {
  format: OutletFormat;
  name: string;
  does: string;
  departments: readonly TemplateDepartment[];
  roles: readonly TemplateRole[];
  checklists: readonly TemplateChecklist[];
  items: readonly StarterItem[];
  /** Modules switched on for the company when this outlet is added (never switched off). */
  modules: readonly ModuleCode[];
}

const item = (
  code: string,
  name: string,
  category: string,
  unit: string,
  perishable: boolean,
  department: string,
  view?: View,
): StarterItem => ({ code, name, category, unit, perishable, department, ...(view && { view }) });

const KITCHEN_ITEMS: readonly StarterItem[] = [
  item('ONIONS', 'Onions', 'Produce', 'kg', true, 'KITCHEN'),
  item('TOMATOES', 'Tomatoes', 'Produce', 'kg', true, 'KITCHEN'),
  item('COOKING-OIL', 'Cooking oil', 'Dry Grocery', 'l', false, 'KITCHEN'),
  item('SALT', 'Salt', 'Dry Grocery', 'kg', false, 'KITCHEN'),
  item('MILK', 'Milk', 'Dairy', 'l', true, 'KITCHEN'),
  item('CLING-FILM', 'Cling film', 'Packaging', 'each', false, 'KITCHEN'),
];
const BAR_ITEMS: readonly StarterItem[] = [
  item('VODKA', 'Vodka', 'Liquor', 'bottle', false, 'BAR'),
  item('WHISKY', 'Whisky', 'Liquor', 'bottle', false, 'BAR'),
  item('BEER', 'Beer', 'Beer', 'bottle', false, 'BAR'),
  item('SODA', 'Soda', 'Mixers', 'can', false, 'BAR'),
  item('LIME', 'Lime', 'Produce', 'each', true, 'BAR'),
];

export const TEMPLATES: readonly OutletTemplate[] = [
  {
    format: 'restaurant',
    name: 'Restaurant / Café',
    does: 'Food served at tables or over a counter, from its own kitchen.',
    departments: [
      { code: 'KITCHEN' },
      { code: 'RESTAURANT', view: 'restaurant' },
      { code: 'COUNTER', view: 'cafe' },
      { code: 'STORES-TEAM', view: 'restaurant' },
      { code: 'ADMIN-FINANCE', on: false },
    ],
    roles: [
      { code: 'RESTAURANT_GENERAL_MANAGER' },
      { code: 'ASSISTANT_MANAGER', view: 'restaurant' },
      { code: 'HEAD_COOK' },
      { code: 'SOUS_CHEF', view: 'restaurant' },
      { code: 'COOK' },
      { code: 'COMMIS', view: 'restaurant' },
      { code: 'KITCHEN_STEWARD' },
      { code: 'BARISTA', department: 'COUNTER', view: 'cafe' },
      { code: 'CAPTAIN', view: 'restaurant' },
      { code: 'STEWARD', view: 'restaurant' },
      { code: 'HOST', view: 'restaurant' },
      { code: 'CASHIER', department: 'RESTAURANT', view: 'restaurant' },
      { code: 'CASHIER', department: 'COUNTER', view: 'cafe' },
      { code: 'STORE_KEEPER' },
      { code: 'ACCOUNTANT' },
    ],
    checklists: [
      { code: 'KITCHEN-OPENING' },
      { code: 'KITCHEN-CLOSING' },
      { code: 'CHILLER-LOG' },
      { code: 'HOT-HOLDING', view: 'restaurant' },
      { code: 'FRYER-OIL', view: 'restaurant' },
      { code: 'CLEANING-SCHEDULE' },
      { code: 'RESTAURANT-OPENING', view: 'restaurant' },
      { code: 'RESTAURANT-CLOSING', view: 'restaurant' },
      { code: 'PRE-SHIFT-BRIEFING', view: 'restaurant' },
      { code: 'COUNTER-OPENING', view: 'cafe' },
      { code: 'COUNTER-CLOSING', view: 'cafe' },
      { code: 'WASHROOM-ROUND', view: 'restaurant' },
      { code: 'WASHROOM-ROUND', department: 'COUNTER', view: 'cafe' },
      { code: 'RECEIVING-CHECK', view: 'restaurant' },
      { code: 'RECEIVING-CHECK', department: 'KITCHEN', view: 'cafe' },
      { code: 'SECTION-SETUP', view: 'restaurant' },
      { code: 'CASHIER-CLOSE', view: 'restaurant' },
      { code: 'CASHIER-CLOSE', department: 'COUNTER', view: 'cafe' },
    ],
    items: [
      ...KITCHEN_ITEMS,
      item('COFFEE-BEANS', 'Coffee beans', 'Dry Grocery', 'kg', false, 'KITCHEN', 'cafe'),
      item('PAPER-CUPS', 'Paper cups', 'Packaging', 'each', false, 'KITCHEN', 'cafe'),
      item('BASMATI-RICE', 'Basmati rice', 'Dry Grocery', 'kg', false, 'STORES-TEAM', 'restaurant'),
    ],
    modules: [
      'production',
      'prep_lists',
      'checklists',
      'leave',
      'swaps',
      'maintenance',
      'menu_sales',
    ],
  },
  {
    format: 'bar_pub',
    name: 'Bar / Pub',
    does: 'Drinks first, food from a small kitchen; the Bar Manager runs the place.',
    departments: [
      { code: 'BAR' },
      { code: 'FLOOR-SERVICE' },
      { code: 'KITCHEN' },
      { code: 'SECURITY', on: false },
      { code: 'STORES-TEAM', on: false },
    ],
    roles: [
      { code: 'BAR_MANAGER' },
      { code: 'FLOOR_MANAGER' },
      { code: 'HEAD_BARTENDER' },
      { code: 'BARTENDER' },
      { code: 'BAR_BACK' },
      { code: 'SERVER' },
      { code: 'HOST', department: 'FLOOR-SERVICE' },
      { code: 'CASHIER' },
      { code: 'HEAD_COOK' },
      { code: 'COOK' },
      { code: 'COMMIS' },
      { code: 'KITCHEN_STEWARD' },
      { code: 'SECURITY_GUARD' },
      { code: 'STORE_KEEPER' },
      { code: 'ACCOUNTANT' },
    ],
    checklists: [
      { code: 'BAR-SETUP' },
      { code: 'BAR-CLOSING' },
      { code: 'BEER-LINE-CLEAN' },
      { code: 'KITCHEN-OPENING' },
      { code: 'KITCHEN-CLOSING' },
      { code: 'CHILLER-LOG' },
      { code: 'CLEANING-SCHEDULE' },
      { code: 'WASHROOM-ROUND', department: 'FLOOR-SERVICE' },
      { code: 'BAR-RESTOCK' },
      { code: 'SECTION-SETUP', department: 'FLOOR-SERVICE' },
      { code: 'CASHIER-CLOSE', department: 'FLOOR-SERVICE' },
      { code: 'SECURITY-PATROL' },
    ],
    items: [...BAR_ITEMS, ...KITCHEN_ITEMS],
    modules: [
      'production',
      'prep_lists',
      'checklists',
      'leave',
      'swaps',
      'maintenance',
      'menu_sales',
    ],
  },
  {
    format: 'qsr',
    name: 'Quick service',
    does: 'Order at a counter, food in minutes; a Store Manager and crew.',
    departments: [{ code: 'COUNTER' }, { code: 'KITCHEN' }, { code: 'STORES-TEAM', on: false }],
    roles: [
      { code: 'QSR_STORE_MANAGER' },
      { code: 'ASSISTANT_STORE_MANAGER' },
      { code: 'SHIFT_MANAGER' },
      { code: 'CREW_TRAINER' },
      { code: 'CREW_MEMBER' },
      { code: 'FOOD_SAFETY_SUPERVISOR' },
      { code: 'STORE_KEEPER' },
    ],
    checklists: [
      { code: 'COUNTER-OPENING' },
      { code: 'COUNTER-CLOSING' },
      { code: 'KITCHEN-OPENING' },
      { code: 'CHILLER-LOG' },
      { code: 'HOT-HOLDING' },
      { code: 'FRYER-OIL' },
      { code: 'CLEANING-SCHEDULE' },
      { code: 'WASHROOM-ROUND', department: 'COUNTER' },
      { code: 'CREW-STATIONS' },
    ],
    items: KITCHEN_ITEMS,
    modules: [
      'production',
      'prep_lists',
      'checklists',
      'leave',
      'swaps',
      'maintenance',
      'menu_sales',
    ],
  },
  {
    format: 'cloud_kitchen',
    name: 'Delivery-only kitchen',
    does: 'No dining room; orders come from delivery apps and are packed here.',
    departments: [{ code: 'KITCHEN' }, { code: 'DISPATCH' }, { code: 'STORES-TEAM' }],
    roles: [
      { code: 'KITCHEN_MANAGER' },
      { code: 'SOUS_CHEF' },
      { code: 'COOK' },
      { code: 'PACKER' },
      { code: 'STORE_KEEPER' },
      { code: 'FOOD_SAFETY_SUPERVISOR' },
      { code: 'ONLINE_PLATFORM_MANAGER', department: 'DISPATCH' },
    ],
    checklists: [
      { code: 'KITCHEN-OPENING' },
      { code: 'KITCHEN-CLOSING' },
      { code: 'CHILLER-LOG' },
      { code: 'HOT-HOLDING' },
      { code: 'CLEANING-SCHEDULE' },
      { code: 'DELIVERY-PACKING' },
      { code: 'RECEIVING-CHECK' },
      { code: 'PLATFORMS-ONLINE' },
    ],
    items: [
      ...KITCHEN_ITEMS,
      item('DELIVERY-BOXES', 'Delivery boxes', 'Packaging', 'each', false, 'STORES-TEAM'),
      item('CARRY-BAGS', 'Carry bags', 'Packaging', 'each', false, 'STORES-TEAM'),
    ],
    modules: [
      'production',
      'prep_lists',
      'checklists',
      'leave',
      'swaps',
      'maintenance',
      'menu_sales',
    ],
  },
  {
    format: 'hotel',
    name: 'Hotel / Resort',
    does: 'Rooms, a restaurant with breakfast; a small hotel ticks fewer departments.',
    departments: [
      { code: 'FRONT-OFFICE' },
      { code: 'HOUSEKEEPING' },
      { code: 'KITCHEN' },
      // breakfast is the restaurant's (Hotel SOP FB-09), not a department of its own
      { code: 'RESTAURANT', note: 'includes breakfast; untick if no meals are served' },
      { code: 'STORES-TEAM' },
      { code: 'ENGINEERING' },
      { code: 'SECURITY' },
      { code: 'ADMIN-FINANCE' },
      { code: 'IN-ROOM-DINING', on: false },
      { code: 'HR', on: false },
      { code: 'SALES-MARKETING', on: false },
      { code: 'SPA-RECREATION', on: false },
    ],
    roles: [
      { code: 'GENERAL_MANAGER' },
      { code: 'ASSISTANT_GENERAL_MANAGER' },
      { code: 'DUTY_MANAGER' },
      { code: 'FRONT_OFFICE_MANAGER' },
      { code: 'FRONT_DESK_EXECUTIVE' },
      { code: 'BELL_CAPTAIN' },
      { code: 'BELLBOY' },
      { code: 'EXECUTIVE_HOUSEKEEPER' },
      { code: 'HOUSEKEEPING_SUPERVISOR' },
      { code: 'ROOM_ATTENDANT' },
      { code: 'PUBLIC_AREA_ATTENDANT' },
      { code: 'LAUNDRY_ATTENDANT' },
      { code: 'EXECUTIVE_CHEF' },
      { code: 'SOUS_CHEF' },
      { code: 'CHEF_DE_PARTIE' },
      { code: 'COMMIS' },
      { code: 'KITCHEN_STEWARD' },
      // a small hotel's kitchen is one cook; the full-service SOP has no such role (7 Oct)
      { code: 'COOK' },
      { code: 'FANDB_MANAGER' },
      { code: 'RESTAURANT_MANAGER' },
      { code: 'CAPTAIN' },
      { code: 'STEWARD' },
      { code: 'IRD_MANAGER' },
      { code: 'IRD_ORDER_TAKER' },
      { code: 'PURCHASE_MANAGER' },
      { code: 'STORE_KEEPER' },
      { code: 'RECEIVING_CLERK' },
      { code: 'CHIEF_ENGINEER' },
      { code: 'TECHNICIAN' },
      { code: 'SECURITY_SUPERVISOR' },
      { code: 'SECURITY_GUARD' },
      { code: 'HR_EXECUTIVE' },
      { code: 'COST_CONTROLLER' },
      { code: 'ACCOUNTANT' },
      { code: 'HR_MANAGER' },
      { code: 'SALES_MANAGER' },
      // the spa's and the pool's people come with those extras (the pool, spa and gym)
    ],
    checklists: [
      { code: 'FRONT-OFFICE-HANDOVER' },
      { code: 'ROOM-CHECK' },
      { code: 'LOBBY-WASHROOM' },
      { code: 'KITCHEN-OPENING' },
      { code: 'KITCHEN-CLOSING' },
      { code: 'CHILLER-LOG' },
      { code: 'HOT-HOLDING' },
      { code: 'CLEANING-SCHEDULE' },
      { code: 'RESTAURANT-OPENING' },
      { code: 'RESTAURANT-CLOSING' },
      { code: 'PRE-SHIFT-BRIEFING' },
      { code: 'RECEIVING-CHECK' },
      { code: 'SECTION-SETUP' },
      { code: 'BELL-DESK' },
      { code: 'ROOM-CLEANING' },
      { code: 'TURNDOWN' },
      { code: 'LAUNDRY-ROUND' },
      { code: 'IRD-TRAYS' },
      { code: 'PLANT-ROUND' },
      { code: 'SECURITY-PATROL' },
    ],
    items: [
      ...KITCHEN_ITEMS,
      item('TOILET-ROLLS', 'Toilet rolls', 'Guest Amenities', 'each', false, 'HOUSEKEEPING'),
      item('SHAMPOO-SACHETS', 'Shampoo sachets', 'Guest Amenities', 'each', false, 'HOUSEKEEPING'),
      item('BED-SHEETS', 'Bed sheets', 'Linen', 'each', false, 'HOUSEKEEPING'),
      item('FLOOR-CLEANER', 'Floor cleaner', 'Cleaning', 'l', false, 'STORES-TEAM'),
    ],
    modules: [
      'production',
      'prep_lists',
      'checklists',
      'leave',
      'swaps',
      'maintenance',
      'menu_sales',
    ],
  },
];

export const TEMPLATE_BY_FORMAT: ReadonlyMap<OutletFormat, OutletTemplate> = new Map(
  TEMPLATES.map((t) => [t.format, t]),
);

/** What else an outlet has ("Anything else here?"). */
export type ExtraCode =
  'bar' | 'banquets' | 'brewery' | 'delivery' | 'central_kitchen' | 'pool' | 'spa' | 'gym';

export interface Extra {
  code: ExtraCode;
  name: string;
  does: string;
  departments?: readonly string[];
  roles?: readonly TemplateRole[];
  checklists?: readonly TemplateChecklist[];
  items?: readonly StarterItem[];
  modules?: readonly ModuleCode[];
  /** A central kitchen: a site of its own beside the outlet, with its own store. */
  site?: true;
}

export const EXTRAS: readonly Extra[] = [
  {
    code: 'bar',
    name: 'A bar',
    does: 'A Bar department and its store, with the bar checklists.',
    departments: ['BAR'],
    roles: [
      { code: 'BAR_MANAGER' },
      { code: 'HEAD_BARTENDER' },
      { code: 'BARTENDER' },
      { code: 'BAR_BACK' },
    ],
    checklists: [
      { code: 'BAR-SETUP' },
      { code: 'BAR-CLOSING' },
      { code: 'BEER-LINE-CLEAN' },
      { code: 'BAR-RESTOCK' },
    ],
    items: BAR_ITEMS,
  },
  {
    code: 'banquets',
    name: 'Banquets and events',
    does: 'Functions and parties: a Banquets department and the Events module.',
    departments: ['BANQUETS'],
    roles: [{ code: 'BANQUET_MANAGER' }, { code: 'BANQUET_CAPTAIN' }, { code: 'BANQUET_SERVER' }],
    checklists: [{ code: 'BANQUET-SETUP' }],
    modules: ['events'],
  },
  {
    code: 'brewery',
    name: 'Brews its own beer',
    does: 'A Brewhouse department and store, with the brewhouse check.',
    departments: ['BREWHOUSE'],
    roles: [{ code: 'HEAD_BREWER' }, { code: 'BREWER' }],
    checklists: [{ code: 'BREW-DAY' }],
    items: [item('MALT', 'Malt', 'Dry Grocery', 'kg', false, 'BREWHOUSE')],
  },
  {
    code: 'delivery',
    name: 'Takes delivery orders',
    does: 'Orders from delivery apps: the packing checklist in the kitchen.',
    checklists: [{ code: 'DELIVERY-PACKING', department: 'KITCHEN' }],
  },
  {
    code: 'central_kitchen',
    name: 'Cooks for our other outlets',
    does: 'A central kitchen beside it, with its own store, sending to the other outlets.',
    roles: [
      { code: 'CENTRAL_KITCHEN_MANAGER' },
      { code: 'CENTRAL_KITCHEN_SUPERVISOR' },
      { code: 'CENTRAL_KITCHEN_CHEF' },
      { code: 'CENTRAL_KITCHEN_COMMIS' },
      { code: 'CENTRAL_KITCHEN_STORE_KEEPER' },
      { code: 'DELIVERY_DRIVER' },
    ],
    modules: ['production'],
    site: true,
  },
  // a hotel's amenities (Hotel SOP EN-08, SP-01 to SP-06): Spa & Recreation with the people
  // and checks each one needs; a repair to any of them is reported in Maintenance as usual
  {
    code: 'pool',
    name: 'A swimming pool',
    does: 'A lifeguard on duty, the pool safety check and the water test every 2 hours.',
    departments: ['SPA-RECREATION'],
    roles: [{ code: 'RECREATION_MANAGER' }, { code: 'LIFEGUARD' }],
    checklists: [{ code: 'POOL-SAFETY' }, { code: 'POOL-WATER-TEST' }],
  },
  {
    code: 'spa',
    name: 'A spa',
    does: 'Spa Manager, therapists and the spa opening hygiene check.',
    departments: ['SPA-RECREATION'],
    roles: [{ code: 'SPA_MANAGER' }, { code: 'THERAPIST' }, { code: 'SPA_RECEPTIONIST' }],
    checklists: [{ code: 'SPA-OPENING' }, { code: 'SPA-DESK' }],
  },
  {
    code: 'gym',
    name: 'A gym',
    does: 'The daily equipment check, run by the Recreation Manager.',
    departments: ['SPA-RECREATION'],
    roles: [{ code: 'RECREATION_MANAGER' }],
    checklists: [{ code: 'GYM-CHECK' }],
  },
];

export const EXTRA_BY_CODE: ReadonlyMap<ExtraCode, Extra> = new Map(EXTRAS.map((e) => [e.code, e]));

/** "What is this outlet?": how people describe a place, each tile one template. */
export interface Tile {
  code: string;
  name: string;
  example: string;
  format: OutletFormat;
  view?: View;
  /** Extras ticked by default. */
  with?: readonly ExtraCode[];
  /** Extras offered ("Anything else here?"). */
  offers: readonly ExtraCode[];
}

export const TILES: readonly Tile[] = [
  {
    code: 'hotel',
    name: 'Hotel / Resort',
    example: 'rooms and a restaurant with breakfast; a bar, spa, pool or gym if it has them',
    format: 'hotel',
    offers: ['bar', 'banquets', 'pool', 'spa', 'gym', 'central_kitchen'],
  },
  {
    code: 'restaurant',
    name: 'Restaurant only',
    example: 'a dining room, no bar',
    format: 'restaurant',
    view: 'restaurant',
    offers: ['banquets', 'delivery', 'central_kitchen'],
  },
  {
    code: 'restaurant_bar',
    name: 'Restaurant + Bar',
    example: 'a restaurant that also serves drinks',
    format: 'restaurant',
    view: 'restaurant',
    with: ['bar'],
    offers: ['bar', 'banquets', 'brewery', 'delivery', 'central_kitchen'],
  },
  {
    code: 'bar_pub',
    name: 'Bar / Pub',
    example: 'drinks first, food from a small kitchen',
    format: 'bar_pub',
    offers: ['banquets', 'brewery', 'delivery'],
  },
  {
    code: 'cafe',
    name: 'Café',
    example: 'coffee, snacks, a counter',
    format: 'restaurant',
    view: 'cafe',
    offers: ['delivery', 'central_kitchen'],
  },
  {
    code: 'qsr',
    name: 'Quick service',
    example: 'order at a counter, food in minutes',
    format: 'qsr',
    offers: ['delivery', 'central_kitchen'],
  },
  {
    code: 'cloud_kitchen',
    name: 'Delivery-only kitchen',
    example: 'no dining room; orders come from apps',
    format: 'cloud_kitchen',
    offers: ['central_kitchen'],
  },
];

export const TILE_BY_CODE: ReadonlyMap<string, Tile> = new Map(TILES.map((t) => [t.code, t]));

/** Is a piece marked for a view on (and first) in this one? */
export const inView = (piece: { view?: View }, view: View | undefined): boolean =>
  !piece.view || !view || piece.view === view;

/** A role's department in a template: its own, else its catalogue home. */
export const roleDepartment = (r: TemplateRole, role: RoleDef, format: OutletFormat): string =>
  r.department ?? role.formatHome?.[format] ?? role.home;

/** Checks the templates, tiles and extras against the catalogue and library; throws. */
export function checkTemplates(): void {
  const depts = new Set(DEPARTMENTS.map((d) => d.code));
  const formats = new Set<string>(OUTLET_FORMATS);
  const pieces = (
    where: string,
    t: Pick<OutletTemplate, 'roles' | 'checklists' | 'items'> & { departments: readonly string[] },
  ) => {
    for (const d of t.departments)
      if (!depts.has(d)) throw new Error(`${where}: ${d} is not a department`);
    for (const r of t.roles) {
      if (!ROLE_BY_CODE.has(r.code)) throw new Error(`${where}: ${r.code} is not a role`);
      if (r.department && !depts.has(r.department))
        throw new Error(`${where}: ${r.department} is not a department`);
    }
    for (const c of t.checklists) {
      const lib = CHECKLIST_BY_CODE.get(c.code);
      if (!lib) throw new Error(`${where}: ${c.code} is not in the checklist library`);
      for (const r of lib.roles) {
        if (!ROLE_BY_CODE.has(r)) throw new Error(`${where}: ${c.code} names ${r}, not a role`);
      }
      const at = c.department ?? lib.department;
      if (!depts.has(at)) throw new Error(`${where}: ${c.code} goes in ${at}, not a department`);
    }
    for (const i of t.items) {
      if (!depts.has(i.department)) throw new Error(`${where}: ${i.code} kept in ${i.department}`);
      if (!/^[A-Z][A-Z0-9-]*$/.test(i.code)) throw new Error(`${where}: bad item code ${i.code}`);
    }
  };
  for (const t of TEMPLATES) {
    if (!formats.has(t.format)) throw new Error(`template for unknown format ${t.format}`);
    const own = new Set(t.departments.map((d) => d.code));
    pieces(t.format, { ...t, departments: [...own] });
    for (const c of t.checklists) {
      const at = c.department ?? CHECKLIST_BY_CODE.get(c.code)!.department;
      if (!own.has(at)) throw new Error(`${t.format}: ${c.code} goes in ${at}, which it lacks`);
    }
  }
  if (new Set(TEMPLATES.map((t) => t.format)).size !== OUTLET_FORMATS.length) {
    throw new Error('every format needs exactly one template');
  }
  for (const e of EXTRAS) {
    pieces(e.code, {
      departments: e.departments ?? [],
      roles: e.roles ?? [],
      checklists: e.checklists ?? [],
      items: e.items ?? [],
    });
  }
  for (const tile of TILES) {
    if (!TEMPLATE_BY_FORMAT.has(tile.format)) throw new Error(`tile ${tile.code}: no template`);
    for (const x of [...(tile.with ?? []), ...tile.offers]) {
      if (!EXTRA_BY_CODE.has(x)) throw new Error(`tile ${tile.code}: no extra ${x}`);
    }
    for (const x of tile.with ?? []) {
      if (!tile.offers.includes(x))
        throw new Error(`tile ${tile.code}: ${x} ticked but not offered`);
    }
  }
}
