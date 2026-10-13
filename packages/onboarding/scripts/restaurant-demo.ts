import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../src/csv';
import { emptyDraft, filesFromDraft, planFromDraft, roleQuestions } from '../src/setup-draft';

// The restaurant demo: a test customer, "[TEST] Restaurant", one restaurant with a bar in
// Panjim, Goa. Writes its onboarding files to docs/onboarding/demo/test-restaurant, ready to
// zip and import in the platform console (see that folder's README).
//
// The outlet is what the set-up wizard makes from the "Restaurant + Bar" tile (ADR 064): its
// departments, stores, job roles, starter checklists, licences and regular jobs come from
// filesFromDraft, as a new restaurant customer's would. On top: one person per job role (and
// an owner and a demo presenter), suppliers, items, a food and a bar menu with recipes, floor
// sections, shift types and a past week of activity.
//
//   pnpm --filter @outlet-ops/onboarding restaurant-demo [--today 2026-10-20]
//
// Activity (files 25 to 35) counts days from the import day, so it is always the last week.
// Licences, the compliance calendar and opening stock have dates: they are written from
// --today (default: today), so run this again just before importing.

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const TODAY = arg('today') ?? new Date().toISOString().slice(0, 10);
const OUT = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  'onboarding',
  'demo',
  'test-restaurant',
);

const day = (n: number) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// a small seeded random, so the files are the same for the same --today
let seed = 20261013;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

type Cell = string | number | undefined | null;
const q = (v: Cell) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ---------------------------------------------------------------------------------------
// The outlet, as the set-up wizard makes it from the "Restaurant + Bar" tile
// ---------------------------------------------------------------------------------------

/** One person per job role the template asks for: [username, name, monthly pay]. */
const NAMES: Record<string, [string, string, number]> = {
  RESTAURANT_GENERAL_MANAGER: ['manager', 'Rhea Fernandes', 120000],
  ASSISTANT_MANAGER: ['assistant-manager', 'Kunal Naik', 60000],
  HEAD_COOK: ['head-cook', 'Anthony Rebelo', 90000],
  SOUS_CHEF: ['sous-chef', 'Shweta Kamat', 55000],
  COOK: ['cook', 'Pradeep Gaude', 32000],
  COMMIS: ['commis', 'Akash Parab', 22000],
  KITCHEN_STEWARD: ['kitchen-steward', 'Ramesh Velip', 17000],
  CAPTAIN: ['captain', "Neil D'Costa", 30000],
  STEWARD: ['steward', 'Jason Pinto', 20000],
  HOST: ['host', 'Ria Desai', 22000],
  CASHIER: ['cashier', 'Omkar Sawant', 24000],
  STORE_KEEPER: ['store-keeper', 'Dinesh Shetye', 28000],
  BAR_MANAGER: ['bar-manager', 'Calvin Rodrigues', 70000],
  HEAD_BARTENDER: ['head-bartender', 'Mario Fernandes', 42000],
  BARTENDER: ['bartender', 'Sana Shaikh', 28000],
  BAR_BACK: ['bar-back', 'Vikas Gawas', 18000],
};
const OWNER = { user: 'test.leena-sequeira', name: 'Leena Sequeira', pay: 200000 };
const PRESENTER = { user: 'restaurant.presenter', name: 'Demo Presenter' };
const U = (user: string) => `restaurant.${user}`;

const draft = emptyDraft();
draft.company = {
  ...draft.company,
  name: '[TEST] Restaurant',
  code: 'RESTAURANT-TEST',
  isTest: true,
  ownerName: OWNER.name,
  // the wizard makes an email owner; the console's "New customer" makes this one a login ID
  // (the README's step 2), and file 07 below says so
  ownerEmail: 'owner@test-restaurant.example',
};
draft.outlets.push({
  key: 'panjim',
  tile: 'restaurant_bar',
  extras: ['bar'],
  name: 'Restaurant & Bar, Panjim',
  area: '',
  location: '15.4989, 73.8278',
  radius: '150',
  items: true,
  roles: {},
  stock: {},
  requestApproval: '',
  purchaseApprover: '',
  ownItems: [],
});
const QUESTIONS = roleQuestions(draft, draft.outlets[0]!);
for (const r of QUESTIONS) {
  const n = NAMES[r.code];
  if (!n) throw new Error(`no person for ${r.code}: add one to NAMES`);
  draft.people.push({ name: n[1], email: '', role: r.code, outlet: 'panjim' });
}
// Events & compliance as well as what the tile buys, so its licences and regular jobs come too
draft.bundlesOn = ['events_compliance'];
const PLAN = planFromDraft(draft);
const wizard = filesFromDraft(draft, TODAY);

const files: Record<string, string> = { ...wizard };
function csv(name: string, header: string[], rows: Cell[][]) {
  // a row may leave out its last, optional columns
  const full = (r: Cell[]) => [
    ...r,
    ...Array<Cell>(Math.max(0, header.length - r.length)).fill(''),
  ];
  files[name] = [header.join(','), ...rows.map((r) => full(r).map(q).join(','))].join('\n') + '\n';
}
/** One of the wizard's files as rows of named values. */
const table = (name: string) => {
  const t = parseCsv(wizard[name]!);
  return { header: t.header, rows: t.rows.map((r) => r.values) };
};

const org = table('01_org_nodes.csv').rows;
const H = org.find((r) => r['kind'] === 'outlet')!['node_code']!;
const CO = org.find((r) => r['kind'] === 'company')!['node_code']!;
const D = (s: string) => `${H}-${s}`;
const KS = D('KITCHEN-STORE');
const MS = D('MAIN-STORE');
const BS = D('BAR-STORE');
for (const store of [KS, MS, BS]) {
  if (!table('02_delivery_nodes.csv').rows.some((r) => r['node_code'] === store)) {
    throw new Error(`the template no longer makes ${store}`);
  }
}

// ---------------------------------------------------------------------------------------
// People: the wizard's users, with demo login IDs, an owner and a demo presenter
// ---------------------------------------------------------------------------------------

interface Person {
  user: string;
  name: string;
  role: string;
  home: string;
  pay: number;
}
const wizardUsers = table('07_users.csv').rows;
const PEOPLE: Person[] = [
  { user: OWNER.user, name: OWNER.name, role: 'ACCOUNT_OWNER', home: CO, pay: OWNER.pay },
  { user: PRESENTER.user, name: PRESENTER.name, role: 'ACCOUNT_OWNER', home: CO, pay: 1 },
  ...wizardUsers
    .filter((r) => r['job_role_code'] !== 'ACCOUNT_OWNER')
    .map((r) => {
      const [user, name, pay] = NAMES[r['job_role_code']!]!;
      return { user: U(user), name, role: r['job_role_code']!, home: r['home_node_code']!, pay };
    }),
];
const byRole = (role: string) => PEOPLE.find((p) => p.role === role)!.user;
const GM = byRole('RESTAURANT_GENERAL_MANAGER');
csv(
  '07_users.csv',
  [
    'username',
    'display_name',
    'job_role_code',
    'home_node_code',
    'login_type',
    'email',
    'employment_type',
    'joined_on',
    'password_mode',
    'demo_presenter',
  ],
  PEOPLE.map((p, i) => [
    p.user,
    p.name,
    p.role,
    p.home,
    'username',
    '',
    'full_time',
    day(-300 - i * 13),
    'test_rule',
    p.user === PRESENTER.user ? 'yes' : 'no',
  ]),
);
csv(
  '08_role_assignments_extra.csv',
  ['username', 'access_group', 'node_code', 'include_descendants', 'reason'],
  [[GM, 'USER_ADMIN', H, 'true', 'The manager adds people and resets their passwords']],
);
csv(
  '04_location_settings.csv',
  ['org_node_code', 'latitude', 'longitude', 'geofence_radius_m'],
  [[H, 15.4989, 73.8278, 150]],
);
// the company file: swaps for the managers only (the default), the demo look worked
csv(
  '00_customer.csv',
  [...table('00_customer.csv').header, 'swaps_managers_only'],
  table('00_customer.csv').rows.map((r) => [
    ...table('00_customer.csv').header.map((h) => r[h]),
    'yes',
  ]),
);

// ---------------------------------------------------------------------------------------
// Suppliers, items and where they are kept
// ---------------------------------------------------------------------------------------

csv(
  '09_suppliers.csv',
  ['supplier_code', 'name', 'lead_time_days', 'contact_email', 'contact_phone'],
  [
    ['SUP-PRODUCE', 'Panjim Market Produce (demo)', 1, 'produce@demo.example', '+91 98230 20001'],
    ['SUP-SEAFOOD', 'Mandovi Fresh Catch (demo)', 1, 'catch@demo.example', '+91 98230 20002'],
    ['SUP-MEAT', 'Altinho Meats (demo)', 1, 'meats@demo.example', '+91 98230 20003'],
    ['SUP-DAIRY', 'Porvorim Dairy & Eggs (demo)', 1, 'dairy@demo.example', '+91 98230 20004'],
    ['SUP-BAKERY', 'Fontainhas Poder (demo)', 1, 'bakery@demo.example', '+91 98230 20005'],
    [
      'SUP-GROCERY',
      'Panjim Wholesale Grocers (demo)',
      2,
      'grocery@demo.example',
      '+91 98230 20006',
    ],
    ['SUP-BAR', 'Mandovi Wines & Spirits (demo)', 2, 'bar@demo.example', '+91 98230 20007'],
    ['SUP-SUNDRY', 'Goa Restaurant Supplies (demo)', 3, 'sundry@demo.example', '+91 98230 20008'],
  ],
);

interface Item {
  code: string;
  name: string;
  cat: string;
  unit: string;
  perishable: boolean;
  cost: number;
  sup: string;
  /** recipe unit and how many make one stock unit */
  conv?: ['g' | 'ml' | 'each', number];
  allergens?: string;
  excise?: boolean;
}
const I = (
  code: string,
  name: string,
  cat: string,
  unit: string,
  perishable: boolean,
  cost: number,
  sup: string,
  more: Partial<Item> = {},
): Item => ({ code, name, cat, unit, perishable, cost, sup, ...more });
const KG: Partial<Item> = { conv: ['g', 1000] };
const LT: Partial<Item> = { conv: ['ml', 1000] };
const BOTTLE: Partial<Item> = { conv: ['ml', 750], excise: true };
const ITEMS: Item[] = [
  // seafood and meat
  I('KINGFISH', 'Kingfish (surmai)', 'Seafood', 'kg', true, 900, 'SUP-SEAFOOD', {
    ...KG,
    allergens: 'fish',
  }),
  I('PRAWNS', 'Prawns, medium', 'Seafood', 'kg', true, 650, 'SUP-SEAFOOD', {
    ...KG,
    allergens: 'crustaceans',
  }),
  I('SQUID', 'Squid', 'Seafood', 'kg', true, 420, 'SUP-SEAFOOD', { ...KG, allergens: 'molluscs' }),
  I('CHICKEN', 'Chicken, curry cut', 'Meat', 'kg', true, 260, 'SUP-MEAT', KG),
  I('PORK', 'Pork shoulder', 'Meat', 'kg', true, 450, 'SUP-MEAT', KG),
  I('CHOURICO', 'Goan chouriço', 'Meat', 'kg', true, 900, 'SUP-MEAT', KG),
  // dairy, eggs and bread
  I('EGGS', 'Eggs', 'Dairy & eggs', 'each', true, 7, 'SUP-DAIRY', { allergens: 'egg' }),
  I('BUTTER', 'Butter', 'Dairy & eggs', 'kg', true, 520, 'SUP-DAIRY', {
    ...KG,
    allergens: 'milk',
  }),
  I('CREAM', 'Fresh cream', 'Dairy & eggs', 'l', true, 240, 'SUP-DAIRY', {
    ...LT,
    allergens: 'milk',
  }),
  I('PANEER', 'Paneer', 'Dairy & eggs', 'kg', true, 380, 'SUP-DAIRY', {
    ...KG,
    allergens: 'milk',
  }),
  I('POI', 'Poi (Goan bread)', 'Bakery', 'each', true, 8, 'SUP-BAKERY', { allergens: 'gluten' }),
  I('PAO', 'Pao', 'Bakery', 'each', true, 6, 'SUP-BAKERY', { allergens: 'gluten' }),
  // produce
  I('ONIONS', 'Onions', 'Produce', 'kg', true, 35, 'SUP-PRODUCE', KG),
  I('TOMATOES', 'Tomatoes', 'Produce', 'kg', true, 40, 'SUP-PRODUCE', KG),
  I('POTATOES', 'Potatoes', 'Produce', 'kg', true, 30, 'SUP-PRODUCE', KG),
  I('GREEN-CHILLIES', 'Green chillies', 'Produce', 'kg', true, 80, 'SUP-PRODUCE', KG),
  I('GINGER', 'Ginger', 'Produce', 'kg', true, 120, 'SUP-PRODUCE', KG),
  I('GARLIC', 'Garlic', 'Produce', 'kg', true, 160, 'SUP-PRODUCE', KG),
  I('CORIANDER', 'Coriander leaves', 'Produce', 'kg', true, 120, 'SUP-PRODUCE', KG),
  I('MINT', 'Mint leaves', 'Produce', 'kg', true, 200, 'SUP-PRODUCE', KG),
  I('LIMES', 'Limes', 'Produce', 'each', true, 4, 'SUP-PRODUCE'),
  I('COCONUT', 'Coconut, fresh', 'Produce', 'each', true, 35, 'SUP-PRODUCE'),
  I('CUCUMBER', 'Cucumber', 'Produce', 'kg', true, 40, 'SUP-PRODUCE', KG),
  // grocery and spices
  I('RICE', 'Goan red rice (ukde)', 'Grocery', 'kg', false, 90, 'SUP-GROCERY', KG),
  I('BASMATI', 'Basmati rice', 'Grocery', 'kg', false, 120, 'SUP-GROCERY', KG),
  I('SEMOLINA', 'Semolina (rava)', 'Grocery', 'kg', false, 50, 'SUP-GROCERY', {
    ...KG,
    allergens: 'gluten',
  }),
  I('SUGAR', 'Sugar', 'Grocery', 'kg', false, 45, 'SUP-GROCERY', KG),
  I('COCONUT-MILK', 'Coconut milk', 'Grocery', 'l', false, 180, 'SUP-GROCERY', LT),
  I('OIL', 'Sunflower oil', 'Grocery', 'l', false, 150, 'SUP-GROCERY', LT),
  I('VINEGAR', 'Toddy vinegar', 'Grocery', 'l', false, 120, 'SUP-GROCERY', LT),
  I('TAMARIND', 'Tamarind', 'Grocery', 'kg', false, 140, 'SUP-GROCERY', KG),
  I('KASHMIRI-CHILLI', 'Kashmiri chilli, dried', 'Spices', 'kg', false, 650, 'SUP-GROCERY', KG),
  I('CUMIN', 'Cumin', 'Spices', 'kg', false, 450, 'SUP-GROCERY', KG),
  I('TURMERIC', 'Turmeric', 'Spices', 'kg', false, 260, 'SUP-GROCERY', KG),
  I('BLACK-PEPPER', 'Black pepper', 'Spices', 'kg', false, 900, 'SUP-GROCERY', KG),
  I('SALT', 'Salt', 'Grocery', 'kg', false, 20, 'SUP-GROCERY', KG),
  I('CASHEWS', 'Cashew nuts', 'Grocery', 'kg', false, 950, 'SUP-GROCERY', {
    ...KG,
    allergens: 'tree nuts',
  }),
  I('FRIES', 'French fries, frozen', 'Grocery', 'kg', true, 140, 'SUP-GROCERY', KG),
  // the bar: spirits, beer, wine and mixers
  I('FENI-750ML', 'Cashew feni 750ml', 'Spirits', 'bottle', false, 650, 'SUP-BAR', BOTTLE),
  I('GIN-750ML', 'Indian craft gin 750ml', 'Spirits', 'bottle', false, 1800, 'SUP-BAR', BOTTLE),
  I('VODKA-750ML', 'Vodka 750ml', 'Spirits', 'bottle', false, 1500, 'SUP-BAR', BOTTLE),
  I('WHITE-RUM-750ML', 'White rum 750ml', 'Spirits', 'bottle', false, 800, 'SUP-BAR', BOTTLE),
  I('DARK-RUM-750ML', 'Dark rum 750ml', 'Spirits', 'bottle', false, 700, 'SUP-BAR', BOTTLE),
  I('WHISKY-750ML', 'Blended whisky 750ml', 'Spirits', 'bottle', false, 1600, 'SUP-BAR', BOTTLE),
  I('TEQUILA-750ML', 'Tequila blanco 750ml', 'Spirits', 'bottle', false, 3200, 'SUP-BAR', BOTTLE),
  I('VERMOUTH-750ML', 'Sweet vermouth 750ml', 'Spirits', 'bottle', false, 1400, 'SUP-BAR', {
    ...BOTTLE,
    allergens: 'sulphites',
  }),
  I('APERITIF-750ML', 'Bitter aperitif 750ml', 'Spirits', 'bottle', false, 1800, 'SUP-BAR', BOTTLE),
  I('LAGER-330ML', 'Lager 330ml', 'Beer', 'bottle', false, 90, 'SUP-BAR', {
    excise: true,
    allergens: 'gluten',
  }),
  I('CRAFT-BEER-330ML', 'Goan craft beer 330ml', 'Beer', 'can', false, 160, 'SUP-BAR', {
    excise: true,
    allergens: 'gluten',
  }),
  I('RED-WINE-750ML', 'Red wine 750ml', 'Wine', 'bottle', false, 900, 'SUP-BAR', {
    ...BOTTLE,
    allergens: 'sulphites',
  }),
  I('WHITE-WINE-750ML', 'White wine 750ml', 'Wine', 'bottle', false, 900, 'SUP-BAR', {
    ...BOTTLE,
    allergens: 'sulphites',
  }),
  I('TONIC-200ML', 'Tonic water 200ml', 'Mixers', 'can', false, 45, 'SUP-BAR', {
    conv: ['ml', 200],
  }),
  I('SODA-750ML', 'Soda 750ml', 'Mixers', 'bottle', false, 25, 'SUP-BAR', { conv: ['ml', 750] }),
  I('COLA-300ML', 'Cola 300ml', 'Mixers', 'can', false, 35, 'SUP-BAR'),
  I('ICE', 'Ice', 'Bar', 'kg', true, 15, 'SUP-SUNDRY', KG),
  // the floor
  I('NAPKINS', 'Paper napkins (pack of 100)', 'Packaging', 'pack', false, 60, 'SUP-SUNDRY'),
  I('TAKEAWAY-BOX', 'Takeaway box 500ml', 'Packaging', 'each', false, 6, 'SUP-SUNDRY'),
];
// counted items are used by count in recipes
for (const i of ITEMS) if (!i.conv && i.unit !== 'kg') i.conv = ['each', 1];
const ITEM = new Map(ITEMS.map((i) => [i.code, i]));
csv(
  '10_items.csv',
  [
    'item_code',
    'name',
    'category',
    'base_unit',
    'is_perishable',
    'standard_unit_cost_inr',
    'preferred_supplier_code',
    'item_type',
    'receive_to',
    'allergens',
    'excise',
  ],
  ITEMS.map((i) => [
    i.code,
    i.name,
    i.cat,
    i.unit,
    i.perishable ? 'yes' : 'no',
    i.cost,
    i.sup,
    'consumable',
    // fresh food goes straight to the kitchen (ADR 080)
    ['Seafood', 'Meat', 'Dairy & eggs', 'Produce', 'Bakery'].includes(i.cat) ? 'department' : '',
    i.allergens ?? '',
    i.excise ? 'yes' : '',
  ]),
);
csv(
  '18_item_unit_conversions.csv',
  ['item_code', 'stock_unit', 'recipe_unit', 'recipe_units_per_stock_unit'],
  ITEMS.filter((i) => i.conv).map((i) => [i.code, i.unit, i.conv![0], i.conv![1]]),
);

// where each item is kept, with par in stock units: the kitchen and the bar keep what they
// use; the Main Store keeps the dry goods, the cellar and the floor's supplies, and sends
const KITCHEN: [string, number][] = [
  ['KINGFISH', 6],
  ['PRAWNS', 8],
  ['SQUID', 4],
  ['CHICKEN', 12],
  ['PORK', 5],
  ['CHOURICO', 3],
  ['EGGS', 180],
  ['BUTTER', 4],
  ['CREAM', 5],
  ['PANEER', 4],
  ['POI', 80],
  ['PAO', 60],
  ['ONIONS', 20],
  ['TOMATOES', 15],
  ['POTATOES', 15],
  ['GREEN-CHILLIES', 2],
  ['GINGER', 2],
  ['GARLIC', 3],
  ['CORIANDER', 1.5],
  ['MINT', 0.5],
  ['LIMES', 80],
  ['COCONUT', 20],
  ['CUCUMBER', 4],
  ['RICE', 10],
  ['BASMATI', 10],
  ['SEMOLINA', 4],
  ['SUGAR', 5],
  ['COCONUT-MILK', 8],
  ['OIL', 12],
  ['VINEGAR', 3],
  ['TAMARIND', 1],
  ['KASHMIRI-CHILLI', 1],
  ['CUMIN', 0.5],
  ['TURMERIC', 0.5],
  ['BLACK-PEPPER', 0.3],
  ['SALT', 5],
  ['CASHEWS', 1],
  ['FRIES', 10],
];
const BAR: [string, number, string][] = [
  ['FENI-750ML', 8, 'Back bar'],
  ['GIN-750ML', 6, 'Back bar'],
  ['VODKA-750ML', 4, 'Back bar'],
  ['WHITE-RUM-750ML', 4, 'Back bar'],
  ['DARK-RUM-750ML', 4, 'Back bar'],
  ['WHISKY-750ML', 6, 'Back bar'],
  ['TEQUILA-750ML', 3, 'Back bar'],
  ['VERMOUTH-750ML', 2, 'Back bar'],
  ['APERITIF-750ML', 2, 'Back bar'],
  ['LAGER-330ML', 72, 'Beer fridge'],
  ['CRAFT-BEER-330ML', 36, 'Beer fridge'],
  ['RED-WINE-750ML', 8, 'Wine rack'],
  ['WHITE-WINE-750ML', 8, 'Wine rack'],
  ['TONIC-200ML', 48, 'Mixer fridge'],
  ['SODA-750ML', 24, 'Mixer fridge'],
  ['COLA-300ML', 36, 'Mixer fridge'],
  ['LIMES', 80, 'Garnish fridge'],
  ['MINT', 0.5, 'Garnish fridge'],
  ['CUCUMBER', 2, 'Garnish fridge'],
  ['SUGAR', 4, 'Dry shelf'],
  ['SALT', 1, 'Dry shelf'],
  ['ICE', 40, 'Ice machine'],
];
const MAIN: [string, number][] = [
  ['RICE', 25],
  ['BASMATI', 25],
  ['SEMOLINA', 10],
  ['SUGAR', 20],
  ['COCONUT-MILK', 24],
  ['OIL', 30],
  ['VINEGAR', 6],
  ['TAMARIND', 3],
  ['KASHMIRI-CHILLI', 3],
  ['CUMIN', 1],
  ['TURMERIC', 1],
  ['BLACK-PEPPER', 1],
  ['SALT', 15],
  ['CASHEWS', 3],
  ['FENI-750ML', 12],
  ['GIN-750ML', 12],
  ['VODKA-750ML', 6],
  ['WHITE-RUM-750ML', 6],
  ['DARK-RUM-750ML', 6],
  ['WHISKY-750ML', 12],
  ['TEQUILA-750ML', 4],
  ['LAGER-330ML', 144],
  ['CRAFT-BEER-330ML', 72],
  ['RED-WINE-750ML', 24],
  ['WHITE-WINE-750ML', 24],
  ['TONIC-200ML', 96],
  ['SODA-750ML', 48],
  ['COLA-300ML', 72],
  ['NAPKINS', 20],
  ['TAKEAWAY-BOX', 300],
];
type Loc = { item: string; store: string; par: number; shelf?: string; order?: number };
const LOCS: Loc[] = [
  ...KITCHEN.map(([item, par]) => ({ item, store: KS, par })),
  ...BAR.map(([item, par, shelf], i) => ({ item, store: BS, par, shelf, order: i })),
  ...MAIN.map(([item, par]) => ({ item, store: MS, par })),
];
csv(
  '11_item_locations.csv',
  [
    'item_code',
    'store_node_code',
    'par_level',
    'reorder_qty',
    'count_tolerance_pct',
    'preferred_supplier_code',
    'shelf',
    'shelf_order',
  ],
  LOCS.map((l) => [
    l.item,
    l.store,
    l.par,
    Math.round(l.par * 5) / 10,
    ITEM.get(l.item)!.perishable ? 10 : 2,
    ITEM.get(l.item)!.sup,
    l.shelf ?? '',
    l.order ?? '',
  ]),
);

// ---------------------------------------------------------------------------------------
// Menus: a Goan kitchen and a cocktail bar, invented for the demo
// ---------------------------------------------------------------------------------------

type Line = [code: string, qty: number, unit: 'g' | 'ml' | 'each', kind?: 'prep'];
interface Prep {
  code: string;
  name: string;
  type: 'kitchen_prep' | 'house_mixer' | 'batched_cocktail';
  unit: 'g' | 'ml';
  yield: number;
  life: number;
  food: 'veg' | 'non_veg';
  portions: number;
  store: string;
  par: number;
  lines: Line[];
  steps: [string, number][];
}
const PREPS: Prep[] = [
  {
    code: 'RECHEADO-MASALA',
    name: 'Recheado masala',
    type: 'kitchen_prep',
    unit: 'g',
    yield: 1000,
    life: 240,
    food: 'veg',
    portions: 25,
    store: KS,
    par: 1500,
    lines: [
      ['KASHMIRI-CHILLI', 120, 'g'],
      ['GARLIC', 80, 'g'],
      ['GINGER', 40, 'g'],
      ['CUMIN', 15, 'g'],
      ['BLACK-PEPPER', 10, 'g'],
      ['VINEGAR', 300, 'ml'],
      ['SUGAR', 40, 'g'],
      ['TAMARIND', 40, 'g'],
    ],
    steps: [
      ['Soak the chillies in the vinegar for an hour.', 60],
      ['Grind everything to a smooth paste; jar and label it.', 15],
    ],
  },
  {
    code: 'XACUTI-MASALA',
    name: 'Xacuti masala',
    type: 'kitchen_prep',
    unit: 'g',
    yield: 1000,
    life: 168,
    food: 'veg',
    portions: 20,
    store: KS,
    par: 1000,
    lines: [
      ['COCONUT', 4, 'each'],
      ['KASHMIRI-CHILLI', 60, 'g'],
      ['ONIONS', 300, 'g'],
      ['GARLIC', 40, 'g'],
      ['TURMERIC', 10, 'g'],
      ['BLACK-PEPPER', 10, 'g'],
      ['OIL', 60, 'ml'],
    ],
    steps: [
      ['Roast the grated coconut and spices until brown.', 20],
      ['Fry the onions, add the roast and grind with water.', 20],
    ],
  },
  {
    code: 'CAFREAL-MARINADE',
    name: 'Cafreal marinade',
    type: 'kitchen_prep',
    unit: 'g',
    yield: 1000,
    life: 72,
    food: 'veg',
    portions: 20,
    store: KS,
    par: 1000,
    lines: [
      ['CORIANDER', 300, 'g'],
      ['MINT', 80, 'g'],
      ['GREEN-CHILLIES', 80, 'g'],
      ['GINGER', 60, 'g'],
      ['GARLIC', 60, 'g'],
      ['LIMES', 6, 'each'],
      ['VINEGAR', 100, 'ml'],
      ['SALT', 20, 'g'],
    ],
    steps: [['Grind everything to a bright green paste; keep it chilled.', 15]],
  },
  {
    code: 'SUGAR-SYRUP',
    name: 'Sugar syrup',
    type: 'house_mixer',
    unit: 'ml',
    yield: 1000,
    life: 336,
    food: 'veg',
    portions: 50,
    store: BS,
    par: 1500,
    lines: [['SUGAR', 650, 'g']],
    steps: [['Dissolve the sugar in 500 ml of hot water; cool and bottle.', 15]],
  },
  {
    code: 'LIME-CORDIAL',
    name: 'Lime cordial',
    type: 'house_mixer',
    unit: 'ml',
    yield: 1000,
    life: 168,
    food: 'veg',
    portions: 40,
    store: BS,
    par: 1000,
    lines: [
      ['LIMES', 20, 'each'],
      ['SUGAR', 400, 'g'],
    ],
    steps: [['Zest and juice the limes; stir into warm syrup and bottle.', 20]],
  },
  {
    code: 'NEGRONI-BATCH',
    name: 'Negroni (pre-batched)',
    type: 'batched_cocktail',
    unit: 'ml',
    yield: 1500,
    life: 720,
    food: 'veg',
    portions: 20,
    store: BS,
    par: 1500,
    lines: [
      ['GIN-750ML', 500, 'ml'],
      ['VERMOUTH-750ML', 500, 'ml'],
      ['APERITIF-750ML', 500, 'ml'],
    ],
    steps: [['Stir equal parts in a jug; bottle, label and chill.', 10]],
  },
];
const PREP = new Map(PREPS.map((p) => [p.code, p]));
csv(
  '19_prep_items.csv',
  [
    'prep_item_code',
    'name',
    'prep_type',
    'unit',
    'batch_yield',
    'shelf_life_hours',
    'food_type',
    'allergens',
    'batch_portions',
  ],
  PREPS.map((p) => [p.code, p.name, p.type, p.unit, p.yield, p.life, p.food, '', p.portions]),
);
csv(
  '20_prep_locations.csv',
  ['prep_item_code', 'store_node_code', 'made_here', 'par_level'],
  PREPS.map((p) => [p.code, p.store, 'yes', p.par]),
);

interface Dish {
  code: string;
  name: string;
  menu: 'Food' | 'Bar';
  cat: string;
  serving: string;
  store: string;
  price: number;
  /** a day's sales, low and high */
  sells: [number, number];
  lines: Line[];
}
const dish = (
  code: string,
  name: string,
  menu: 'Food' | 'Bar',
  cat: string,
  serving: string,
  price: number,
  sells: [number, number],
  lines: Line[],
): Dish => ({
  code,
  name,
  menu,
  cat,
  serving,
  store: menu === 'Food' ? KS : BS,
  price,
  sells,
  lines,
});
const P_ = 'prep' as const;
const DISHES: Dish[] = [
  // small plates
  dish(
    'PRAWN-RAVA-FRY',
    'Prawn rava fry',
    'Food',
    'Small plates',
    '1 plate',
    520,
    [6, 12],
    [
      ['PRAWNS', 150, 'g'],
      ['SEMOLINA', 40, 'g'],
      ['RECHEADO-MASALA', 30, 'g', P_],
      ['OIL', 40, 'ml'],
      ['LIMES', 0.5, 'each'],
    ],
  ),
  dish(
    'SQUID-BUTTER-GARLIC',
    'Squid butter garlic',
    'Food',
    'Small plates',
    '1 plate',
    480,
    [4, 9],
    [
      ['SQUID', 150, 'g'],
      ['BUTTER', 30, 'g'],
      ['GARLIC', 20, 'g'],
      ['PAO', 1, 'each'],
    ],
  ),
  dish(
    'CHOURICO-PAO',
    'Chouriço pao',
    'Food',
    'Small plates',
    '2 pao',
    360,
    [5, 10],
    [
      ['CHOURICO', 100, 'g'],
      ['ONIONS', 50, 'g'],
      ['PAO', 2, 'each'],
    ],
  ),
  dish(
    'PANEER-CAFREAL',
    'Paneer cafreal tikka',
    'Food',
    'Small plates',
    '6 pieces',
    380,
    [4, 8],
    [
      ['PANEER', 180, 'g'],
      ['CAFREAL-MARINADE', 40, 'g', P_],
      ['OIL', 15, 'ml'],
    ],
  ),
  dish(
    'MASALA-FRIES',
    'Masala fries',
    'Food',
    'Small plates',
    '1 bowl',
    220,
    [8, 15],
    [
      ['FRIES', 200, 'g'],
      ['OIL', 30, 'ml'],
      ['KASHMIRI-CHILLI', 3, 'g'],
      ['SALT', 3, 'g'],
    ],
  ),
  // mains
  dish(
    'KINGFISH-RECHEADO',
    'Kingfish recheado',
    'Food',
    'Mains',
    '1 portion',
    680,
    [5, 10],
    [
      ['KINGFISH', 200, 'g'],
      ['RECHEADO-MASALA', 40, 'g', P_],
      ['OIL', 30, 'ml'],
      ['RICE', 150, 'g'],
    ],
  ),
  dish(
    'PRAWN-CURRY-RICE',
    'Goan prawn curry & rice',
    'Food',
    'Mains',
    '1 portion',
    560,
    [7, 14],
    [
      ['PRAWNS', 150, 'g'],
      ['COCONUT-MILK', 150, 'ml'],
      ['ONIONS', 60, 'g'],
      ['TAMARIND', 10, 'g'],
      ['KASHMIRI-CHILLI', 6, 'g'],
      ['RICE', 150, 'g'],
    ],
  ),
  dish(
    'CHICKEN-XACUTI',
    'Chicken xacuti & poi',
    'Food',
    'Mains',
    '1 portion',
    480,
    [6, 12],
    [
      ['CHICKEN', 220, 'g'],
      ['XACUTI-MASALA', 80, 'g', P_],
      ['OIL', 20, 'ml'],
      ['POI', 2, 'each'],
    ],
  ),
  dish(
    'CHICKEN-CAFREAL',
    'Chicken cafreal & fries',
    'Food',
    'Mains',
    '1 portion',
    460,
    [5, 10],
    [
      ['CHICKEN', 220, 'g'],
      ['CAFREAL-MARINADE', 50, 'g', P_],
      ['FRIES', 120, 'g'],
      ['OIL', 30, 'ml'],
    ],
  ),
  dish(
    'PORK-VINDALHO',
    'Pork vindalho & poi',
    'Food',
    'Mains',
    '1 portion',
    540,
    [4, 9],
    [
      ['PORK', 220, 'g'],
      ['RECHEADO-MASALA', 50, 'g', P_],
      ['ONIONS', 80, 'g'],
      ['POI', 2, 'each'],
    ],
  ),
  dish(
    'VEG-XACUTI',
    'Vegetable xacuti & rice',
    'Food',
    'Mains',
    '1 portion',
    380,
    [3, 7],
    [
      ['POTATOES', 150, 'g'],
      ['XACUTI-MASALA', 80, 'g', P_],
      ['BASMATI', 150, 'g'],
    ],
  ),
  dish(
    'BUTTER-PAO',
    'Butter pao basket',
    'Food',
    'Sides',
    '4 pao',
    120,
    [6, 12],
    [
      ['PAO', 4, 'each'],
      ['BUTTER', 20, 'g'],
    ],
  ),
  dish(
    'STEAMED-RICE',
    'Steamed basmati',
    'Food',
    'Sides',
    '1 bowl',
    140,
    [8, 14],
    [['BASMATI', 150, 'g']],
  ),
  dish(
    'CASHEW-SALAD',
    'Kachumber with cashews',
    'Food',
    'Sides',
    '1 bowl',
    180,
    [3, 7],
    [
      ['CUCUMBER', 100, 'g'],
      ['TOMATOES', 80, 'g'],
      ['ONIONS', 40, 'g'],
      ['CASHEWS', 20, 'g'],
      ['LIMES', 0.5, 'each'],
    ],
  ),
  // the bar: cocktails, the classics, beer and wine
  dish(
    'FENI-SOUR',
    'Feni sour',
    'Bar',
    'Cocktails',
    '1 glass',
    620,
    [6, 12],
    [
      ['FENI-750ML', 60, 'ml'],
      ['LIME-CORDIAL', 30, 'ml', P_],
      ['SUGAR-SYRUP', 10, 'ml', P_],
      ['ICE', 150, 'g'],
    ],
  ),
  dish(
    'GOAN-GIMLET',
    'Goan gimlet',
    'Bar',
    'Cocktails',
    '1 glass',
    720,
    [4, 9],
    [
      ['GIN-750ML', 60, 'ml'],
      ['LIME-CORDIAL', 30, 'ml', P_],
      ['ICE', 150, 'g'],
    ],
  ),
  dish(
    'NEGRONI',
    'Negroni',
    'Bar',
    'Cocktails',
    '1 glass',
    840,
    [3, 8],
    [
      ['NEGRONI-BATCH', 90, 'ml', P_],
      ['ICE', 120, 'g'],
    ],
  ),
  dish(
    'MOJITO',
    'Mojito',
    'Bar',
    'Cocktails',
    '1 glass',
    620,
    [6, 12],
    [
      ['WHITE-RUM-750ML', 60, 'ml'],
      ['MINT', 8, 'g'],
      ['LIMES', 1, 'each'],
      ['SUGAR-SYRUP', 20, 'ml', P_],
      ['SODA-750ML', 60, 'ml'],
      ['ICE', 150, 'g'],
    ],
  ),
  dish(
    'MARGARITA',
    'Margarita',
    'Bar',
    'Cocktails',
    '1 glass',
    780,
    [3, 7],
    [
      ['TEQUILA-750ML', 50, 'ml'],
      ['LIME-CORDIAL', 25, 'ml', P_],
      ['SALT', 2, 'g'],
      ['ICE', 150, 'g'],
    ],
  ),
  dish(
    'GIN-TONIC',
    'Gin & tonic',
    'Bar',
    'Classics',
    '1 glass',
    680,
    [6, 12],
    [
      ['GIN-750ML', 60, 'ml'],
      ['TONIC-200ML', 200, 'ml'],
      ['CUCUMBER', 10, 'g'],
      ['ICE', 150, 'g'],
    ],
  ),
  dish(
    'WHISKY-SODA',
    'Whisky soda',
    'Bar',
    'Classics',
    '1 glass',
    560,
    [8, 15],
    [
      ['WHISKY-750ML', 60, 'ml'],
      ['SODA-750ML', 120, 'ml'],
      ['ICE', 100, 'g'],
    ],
  ),
  dish(
    'RUM-COLA',
    'Rum & cola',
    'Bar',
    'Classics',
    '1 glass',
    480,
    [5, 10],
    [
      ['DARK-RUM-750ML', 60, 'ml'],
      ['COLA-300ML', 1, 'each'],
      ['ICE', 100, 'g'],
    ],
  ),
  dish(
    'VODKA-SODA',
    'Vodka soda & lime',
    'Bar',
    'Classics',
    '1 glass',
    520,
    [4, 8],
    [
      ['VODKA-750ML', 60, 'ml'],
      ['SODA-750ML', 120, 'ml'],
      ['LIMES', 0.5, 'each'],
      ['ICE', 100, 'g'],
    ],
  ),
  dish(
    'LAGER',
    'Lager, bottle',
    'Bar',
    'Beer & wine',
    '330 ml',
    320,
    [15, 30],
    [['LAGER-330ML', 1, 'each']],
  ),
  dish(
    'CRAFT-BEER',
    'Goan craft beer',
    'Bar',
    'Beer & wine',
    '330 ml',
    480,
    [6, 12],
    [['CRAFT-BEER-330ML', 1, 'each']],
  ),
  dish(
    'RED-WINE-GLASS',
    'Red wine, glass',
    'Bar',
    'Beer & wine',
    '150 ml',
    640,
    [4, 9],
    [['RED-WINE-750ML', 150, 'ml']],
  ),
  dish(
    'WHITE-WINE-GLASS',
    'White wine, glass',
    'Bar',
    'Beer & wine',
    '150 ml',
    640,
    [4, 9],
    [['WHITE-WINE-750ML', 150, 'ml']],
  ),
  dish(
    'FRESH-LIME-SODA',
    'Fresh lime soda',
    'Bar',
    'Soft drinks',
    '1 glass',
    180,
    [6, 12],
    [
      ['LIMES', 1, 'each'],
      ['SUGAR-SYRUP', 20, 'ml', P_],
      ['SODA-750ML', 200, 'ml'],
      ['ICE', 100, 'g'],
    ],
  ),
];
csv(
  '22_menu_items.csv',
  ['menu_item_code', 'name', 'menu', 'category', 'serving'],
  DISHES.map((d) => [d.code, d.name, d.menu, d.cat, d.serving]),
);
csv(
  '23_menu_outlets.csv',
  ['menu_item_code', 'outlet_code', 'sold_from_store_code', 'price_inr_before_tax', 'pos_code'],
  DISHES.map((d, i) => [d.code, H, d.store, d.price, String(7001 + i)]),
);
csv(
  '21_recipes.csv',
  [
    'recipe_for_code',
    'recipe_for_kind',
    'ingredient_code',
    'ingredient_kind',
    'quantity',
    'unit',
    'trim_loss_pct',
  ],
  [
    ...PREPS.flatMap((p) =>
      p.lines.map(([c, n, u, k]) => [p.code, 'prep', c, k === 'prep' ? 'prep' : 'raw', n, u, 0]),
    ),
    ...DISHES.flatMap((d) =>
      d.lines.map(([c, n, u, k]) => [
        d.code,
        'menu',
        c,
        k === 'prep' ? 'prep' : 'raw',
        n,
        u,
        ['PRAWNS', 'KINGFISH', 'SQUID'].includes(c) ? 10 : 0,
      ]),
    ),
  ],
);
// a dish's method (ADR 078): the kitchen's signatures
csv(
  '24_prep_procedures.csv',
  ['prep_item_code', 'recipe_for_kind', 'step', 'instruction', 'minutes'],
  [
    ...PREPS.flatMap((p) => p.steps.map(([s, m], i) => [p.code, 'prep', i + 1, s, m])),
    ['KINGFISH-RECHEADO', 'menu', 1, 'Slit the kingfish and stuff it with the masala.', 5],
    ['KINGFISH-RECHEADO', 'menu', 2, 'Shallow fry until crisp; serve with red rice.', 12],
    ['PRAWN-CURRY-RICE', 'menu', 1, 'Fry the onions; add the chilli and tamarind.', 8],
    ['PRAWN-CURRY-RICE', 'menu', 2, 'Add coconut milk and prawns; simmer, do not boil.', 8],
    ['CHICKEN-XACUTI', 'menu', 1, 'Brown the chicken in oil.', 8],
    ['CHICKEN-XACUTI', 'menu', 2, 'Add the masala and water; simmer until tender.', 25],
  ],
);

// floor sections (ADR 133): the dining room and the bar's terrace
csv(
  '47_sections.csv',
  ['department_code', 'section', 'position'],
  [
    [D('RESTAURANT'), 'Section 1', 1],
    [D('RESTAURANT'), 'Section 2', 2],
    [D('RESTAURANT'), 'Section 3', 3],
    [D('BAR'), 'Bar counter', 1],
    [D('BAR'), 'Terrace', 2],
  ],
);

// ---------------------------------------------------------------------------------------
// A past week: sales, batches, purchases, a stock check; and opening stock to carry it
// ---------------------------------------------------------------------------------------

const SALES: Cell[][] = [];
const used = new Map<string, number>(); // `item store` -> stock units used over the week
const prepUsed = new Map<string, number>(); // `prep day` -> what that day's sales take
const useOf = (code: string, store: string, qty: number, unit: string) => {
  const item = ITEM.get(code);
  if (!item) return; // a prep
  const per = item.conv && unit !== 'each' ? item.conv[1] : 1;
  const k = `${code} ${store}`;
  used.set(k, (used.get(k) ?? 0) + qty / per);
};
for (let d = -7; d <= -1; d++) {
  const weekend = [5, 6].includes(new Date(`${day(d)}T00:00:00Z`).getUTCDay()) ? 1.4 : 1;
  for (const x of DISHES) {
    const n = Math.round(pick(x.sells[0], x.sells[1]) * weekend);
    SALES.push([H, d, x.code, n, GM]);
    for (const [c, qty, unit, kind] of x.lines) {
      if (kind !== 'prep') useOf(c, x.store, n * qty, unit);
      else prepUsed.set(`${c} ${d}`, (prepUsed.get(`${c} ${d}`) ?? 0) + n * qty);
    }
  }
}
csv(
  '27_sales_TEST_DATA_ONLY.csv',
  ['outlet_code', 'day', 'menu_item_code', 'quantity', 'posted_by'],
  SALES,
);

// batches every day, whole ones enough for what the day sells (ADR 114)
const PRODUCTION: Cell[][] = [];
for (const p of PREPS) {
  for (let d = -7; d <= -1; d++) {
    const need = prepUsed.get(`${p.code} ${d}`) ?? 0;
    PRODUCTION.push([
      p.store,
      p.code,
      d,
      p.store === KS ? '09:30' : '16:30',
      p.yield * Math.max(1, Math.ceil(need / p.yield)),
      p.store === KS ? byRole('COOK') : byRole('BARTENDER'),
    ]);
  }
}
for (const [store, code, , , qty] of PRODUCTION as [string, string, number, string, number][]) {
  const p = PREP.get(code)!;
  for (const [c, n, u] of p.lines) useOf(c, store, (qty / p.yield) * n, u);
}
csv(
  '26_production_TEST_DATA_ONLY.csv',
  ['store_node_code', 'prep_item_code', 'day', 'time', 'quantity', 'made_by'],
  PRODUCTION,
);

// opening stock, eight days back: par plus what the week used
csv(
  '12_opening_stock.csv',
  ['item_code', 'store_node_code', 'quantity', 'unit_cost_inr', 'as_of_date'],
  LOCS.map((l) => {
    const it = ITEM.get(l.item)!;
    const u = used.get(`${l.item} ${l.store}`) ?? 0;
    const whole = ['each', 'bottle', 'can', 'pack'].includes(it.unit);
    const qty = l.par * 0.7 + u * 1.05;
    return [l.item, l.store, whole ? Math.ceil(qty) : Math.round(qty * 10) / 10, it.cost, day(-8)];
  }),
);

// orders the store keeper placed at the Main Store, the manager approving; one arriving today
const SK = byRole('STORE_KEEPER');
const po = (
  ref: string,
  sup: string,
  item: string,
  qty: number,
  ordered: number,
  received: number | null,
  receivedQty: number | null = qty,
): Cell[] => [
  ref,
  MS,
  sup,
  item,
  qty,
  ITEM.get(item)!.cost,
  ordered,
  SK,
  GM,
  received ?? '',
  received === null ? '' : receivedQty,
  received === null ? '' : SK,
];
csv(
  '33_purchases_TEST_DATA_ONLY.csv',
  [
    'order_ref',
    'store_node_code',
    'supplier_code',
    'item_code',
    'quantity',
    'unit_cost_inr',
    'ordered_day',
    'ordered_by',
    'approved_by',
    'received_day',
    'received_quantity',
    'received_by',
  ],
  [
    po('PO-1', 'SUP-GROCERY', 'RICE', 20, -6, -4),
    po('PO-1', 'SUP-GROCERY', 'OIL', 20, -6, -4),
    po('PO-1', 'SUP-GROCERY', 'COCONUT-MILK', 12, -6, -4, 10),
    po('PO-2', 'SUP-BAR', 'LAGER-330ML', 96, -5, -3),
    po('PO-2', 'SUP-BAR', 'GIN-750ML', 6, -5, -3),
    po('PO-2', 'SUP-BAR', 'WHISKY-750ML', 6, -5, -3),
    po('PO-3', 'SUP-SUNDRY', 'NAPKINS', 10, -2, null),
    po('PO-3', 'SUP-SUNDRY', 'TAKEAWAY-BOX', 200, -2, null),
  ],
);

// the bar's closing count yesterday
const HB = byRole('HEAD_BARTENDER');
csv(
  '28_counts_TEST_DATA_ONLY.csv',
  ['store_node_code', 'item_code', 'difference', 'counted_by', 'approved_by'],
  [
    [BS, 'FENI-750ML', -0.2, HB, GM],
    [BS, 'GIN-750ML', -0.1, HB, GM],
    [BS, 'LAGER-330ML', -2, HB, GM],
    [BS, 'TONIC-200ML', 0, HB, GM],
  ],
);

// ---------------------------------------------------------------------------------------
// People's time: leave, roster, shifts, attendance, pay
// ---------------------------------------------------------------------------------------

csv(
  '13_leave_types.csv',
  ['leave_type_code', 'name', 'annual_days', 'balance_tracked'],
  [
    ['CASUAL_LEAVE', 'Casual leave', 12, 'yes'],
    ['SICK_LEAVE', 'Sick leave', 12, 'yes'],
    ['EARNED_LEAVE', 'Earned leave', 18, 'yes'],
  ],
);
csv(
  '14_leave_balances.csv',
  ['username', 'leave_type_code', 'year', 'entitled_days', 'used_days'],
  PEOPLE.filter((p) => p.user !== PRESENTER.user).flatMap((p) => [
    [p.user, 'CASUAL_LEAVE', TODAY.slice(0, 4), 12, pick(0, 5)],
    [p.user, 'SICK_LEAVE', TODAY.slice(0, 4), 12, pick(0, 3)],
    [p.user, 'EARNED_LEAVE', TODAY.slice(0, 4), 18, pick(0, 6)],
  ]),
);
csv(
  '15_roster_settings.csv',
  ['setting', 'value', 'meaning'],
  [
    ['min_rest_hours', 10, 'Minimum hours between the end of one shift and the start of the next'],
    ['weekly_hours_cap', 54, 'Maximum rostered hours per worker, Monday to Sunday'],
    ['late_threshold_min', 10, 'Minutes after shift start before a clock-in counts as late'],
  ],
);

// who works shifts, when: [role, department, shift, start, end]
const SHIFTS: [string, string, string, string, string][] = [
  ['SOUS_CHEF', 'KITCHEN', 'Morning', '08:00', '16:00'],
  ['COOK', 'KITCHEN', 'Morning', '08:00', '16:00'],
  ['COMMIS', 'KITCHEN', 'Evening', '15:00', '23:00'],
  ['KITCHEN_STEWARD', 'KITCHEN', 'Evening', '15:00', '23:00'],
  ['CAPTAIN', 'RESTAURANT', 'Evening', '15:00', '23:00'],
  ['STEWARD', 'RESTAURANT', 'Evening', '15:00', '23:00'],
  ['HOST', 'RESTAURANT', 'Evening', '15:00', '23:00'],
  ['CASHIER', 'RESTAURANT', 'Evening', '15:00', '23:00'],
  ['HEAD_BARTENDER', 'BAR', 'Evening', '16:00', '00:00'],
  ['BARTENDER', 'BAR', 'Evening', '16:00', '00:00'],
  ['BAR_BACK', 'BAR', 'Evening', '16:00', '00:00'],
  ['STORE_KEEPER', 'STORES-TEAM', 'Day', '09:00', '17:00'],
];
const headOf: Record<string, string> = {
  KITCHEN: 'HEAD_COOK',
  RESTAURANT: 'RESTAURANT_GENERAL_MANAGER',
  BAR: 'BAR_MANAGER',
  'STORES-TEAM': 'RESTAURANT_GENERAL_MANAGER',
};
const OFF = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** The days a person works: everyone has one day off, the i-th of the week. */
const workDays = (i: number) => {
  const off = i % 7;
  const runs: string[] = [];
  let from = -1;
  for (let j = 0; j <= 7; j++) {
    const on = j < 7 && j !== off;
    if (on && from < 0) from = j;
    if (!on && from >= 0) {
      runs.push(from === j - 1 ? OFF[from]! : `${OFF[from]}-${OFF[j - 1]}`);
      from = -1;
    }
  }
  return runs.join(',');
};
// every day of the week: the restaurant opens daily, so a day off leaves a slot to fill
const templates = new Map<string, Cell[]>();
for (const [role, dept, shift, start, end] of SHIFTS) {
  const k = `${dept} ${shift} ${role}`;
  templates.set(k, [D(dept), shift, start, end, role, 1, 'Mon-Sun', '', '', '', '']);
}
csv(
  '16_shift_templates.csv',
  [
    'roster_node_code',
    'shift_name',
    'start_time',
    'end_time',
    'job_role_code',
    'headcount',
    'days',
    'shift_type',
    'first_end',
    'second_start',
    'break_minutes',
  ],
  [...templates.values()],
);
csv(
  '25_shifts_TEST_DATA_ONLY.csv',
  ['roster_node_code', 'shift_name', 'job_role_code', 'week', 'days', 'username', 'rostered_by'],
  // the past seven days as worked (file 35), today to Sunday, and next week (ADR 114)
  [-1, 0, 1].flatMap((week) =>
    SHIFTS.map(([role, dept, shift], i) => [
      D(dept),
      shift,
      role,
      week,
      workDays(i),
      byRole(role),
      byRole(headOf[dept]!),
    ]),
  ),
);
// the past week's clock-ins, a few late, one missing
const ATTENDANCE: Cell[][] = [];
for (const [i, [role, , , start, end]] of SHIFTS.entries()) {
  for (let d = -7; d <= -1; d++) {
    if ((d + 7 + i) % 7 === 0) continue; // a day off
    if (role === 'BAR_BACK' && d === -2) continue; // a no-show
    const late = (i + d) % 9 === 0 ? 14 : pick(0, 6);
    const [h, m] = start.split(':').map(Number) as [number, number];
    const inAt = `${String(h + Math.floor((m + late) / 60)).padStart(2, '0')}:${String((m + late) % 60).padStart(2, '0')}`;
    ATTENDANCE.push([byRole(role), d, inAt, end === '00:00' ? '23:55' : end]);
  }
}
csv('35_attendance_TEST_DATA_ONLY.csv', ['username', 'day', 'clock_in', 'clock_out'], ATTENDANCE);
csv(
  '34_pay_rates.csv',
  ['username', 'pay_basis', 'pay_rate_inr'],
  PEOPLE.filter((p) => p.user !== PRESENTER.user).map((p) => [p.user, 'monthly', p.pay]),
);

// a prep task for today, a repair and a one-off job: the To do lists are not empty
csv(
  '32_prep_tasks_TEST_DATA_ONLY.csv',
  ['store_node_code', 'prep_item_code', 'day', 'due_time', 'quantity', 'assign_to', 'created_by'],
  [
    [KS, 'XACUTI-MASALA', 0, '11:00', 1000, `person:${byRole('COOK')}`, byRole('SOUS_CHEF')],
    [BS, 'LIME-CORDIAL', 0, '17:00', 1000, `person:${byRole('BARTENDER')}`, byRole('BAR_MANAGER')],
  ],
);
csv(
  '31_maintenance_TEST_DATA_ONLY.csv',
  ['place_code', 'title', 'description', 'reported_by', 'assigned_to', 'assigned_by'],
  [[D('BAR'), 'Beer fridge not cooling', 'Reading 9 °C at opening', HB, '', '']],
);
csv(
  '30_tasks_TEST_DATA_ONLY.csv',
  [
    'place_code',
    'title',
    'description',
    'day',
    'due_time',
    'priority',
    'assign_to',
    'steps',
    'created_by',
    'done_by',
  ],
  [
    [
      D('RESTAURANT'),
      'Polish the terrace glassware',
      '',
      0,
      '17:30',
      'normal',
      `person:${byRole('STEWARD')}`,
      'Wine glasses;Highballs',
      byRole('CAPTAIN'),
      '',
    ],
  ],
);

// ---------------------------------------------------------------------------------------
// Licences and the regular jobs: the wizard's, with numbers and dates
// ---------------------------------------------------------------------------------------

const lic = table('38_licences.csv');
csv(
  '38_licences.csv',
  lic.header,
  lic.rows.map((r, i) => {
    // the bar licence comes up for renewal in 20 days; the rest are current
    const expires = r['kind'] === 'EXCISE_BAR' ? day(20) : day(120 + i * 45);
    return lic.header.map((h) =>
      h === 'number'
        ? `${r['kind']!.slice(0, 3)}-${2026}-${String(4100 + i)}`
        : h === 'issued_on'
          ? day(-245 + i)
          : h === 'expires_on'
            ? expires
            : r[h],
    );
  }),
);

// ---------------------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (/^\d\d_.*\.csv$/.test(f)) rmSync(join(OUT, f));
for (const [name, text] of Object.entries(files)) writeFileSync(join(OUT, name), text);
console.log(
  `wrote ${Object.keys(files).length} files to ${OUT} (dates from ${TODAY}); plan: ${Object.entries(
    PLAN,
  )
    .filter(([, on]) => on)
    .map(([b]) => b)
    .join(', ')}`,
);
