import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The Passport Hotel pilot demo: a test customer, "[TEST] Passport Hotel", Assagao, Goa (27
// keys). Writes its onboarding files to docs/onboarding/demo/passport-hotel, ready to zip and
// import in the platform console (see that folder's README). One person per job role, the
// departments as the hotel runs them, their real Mini Bar signatures and an invented rest of
// the menu, a past week of activity, rooms and minibars.
//
//   pnpm --filter @outlet-ops/onboarding passport-demo [--today 2026-10-20]
//
// Activity (files 25 to 36, 42) counts days from the import day, so it is always the last
// week. Events, licences, the compliance calendar and opening stock have dates: they are
// written from --today (default: today), so run this again just before importing.

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
  'passport-hotel',
);

const day = (n: number) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// a small seeded random, so the files are the same for the same --today
let seed = 20261007;
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
const files: Record<string, string> = {};
function csv(name: string, header: string[], rows: Cell[][]) {
  files[name] = [header.join(','), ...rows.map((r) => r.map(q).join(','))].join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------
// The company, the hotel, its departments and stores
// ---------------------------------------------------------------------------------------

const CO = 'PASSPORT-TEST';
const H = 'PASSPORT-ASSAGAO';
const TZ = 'Asia/Kolkata';
const D = (s: string) => `${H}-${s}`;

csv(
  '00_customer.csv',
  [
    'customer_code',
    'company_name',
    'country',
    'currency',
    'default_timezone',
    'is_test',
    'swaps_managers_only',
  ],
  [[CO, '[TEST] Passport Hotel', 'India', 'INR', TZ, 'yes', 'yes']],
);

const DEPTS: [code: string, name: string, type: string][] = [
  ['FRONT-OFFICE', 'Front Office', 'other'],
  ['HOUSEKEEPING', 'Housekeeping', 'housekeeping'],
  ['KITCHEN', 'Kitchen', 'kitchen'],
  ['RESTAURANT', 'Restaurant', 'service'],
  ['BAR', 'Bar (Layover & Mini Bar)', 'service'],
  ['IN-ROOM-DINING', 'In-Room Dining', 'service'],
  ['BANQUETS', 'Sales, Events & Banquets', 'service'],
  ['CASHIER', 'Cashier', 'other'],
  ['ENGINEERING', 'Engineering & Maintenance', 'other'],
  ['STORES-TEAM', 'Purchase & Stores', 'other'],
  ['ADMIN-FINANCE', 'Admin & Finance', 'other'],
];
csv(
  '01_org_nodes.csv',
  ['node_code', 'name', 'kind', 'parent_code', 'timezone', 'outlet_format', 'department_type'],
  [
    [CO, '[TEST] Passport Hotel', 'company', '', '', '', ''],
    [H, 'Passport Hotel, Assagao', 'outlet', CO, TZ, 'hotel', ''],
    ...DEPTS.map(([c, n, t]) => [D(c), n, 'department', H, TZ, '', t]),
  ],
);

const NET = 'PASSPORT-SUPPLY-NETWORK';
const SUPPLY = D('SUPPLY');
const MAIN = D('MAIN-STORE');
const KS = D('KITCHEN-STORE');
const LAYOVER = D('LAYOVER-BAR-STORE');
const LOBBY = D('MINI-BAR-STORE');
const HK = D('HOUSEKEEPING-STORE');
csv(
  '02_delivery_nodes.csv',
  ['node_code', 'name', 'kind', 'parent_code', 'timezone', 'holds_stock', 'is_main_store'],
  [
    [NET, 'Passport Hotel – Supply Network', 'network', '', '', 'no', 'no'],
    [SUPPLY, 'Passport Hotel – Supply Point', 'outlet', NET, TZ, 'no', 'no'],
    [MAIN, 'Main Store', 'store', SUPPLY, TZ, 'yes', 'yes'],
    [KS, 'Kitchen Store', 'store', SUPPLY, TZ, 'yes', 'no'],
    [LAYOVER, 'Layover Bar (rooftop)', 'store', SUPPLY, TZ, 'yes', 'no'],
    [LOBBY, 'Mini Bar (lobby)', 'store', SUPPLY, TZ, 'yes', 'no'],
    [HK, 'Housekeeping Store (with the in-room minibars)', 'store', SUPPLY, TZ, 'yes', 'no'],
  ],
);
csv(
  '03_node_links.csv',
  ['org_node_code', 'delivery_node_code', 'note'],
  [
    [H, SUPPLY, 'The hotel and its supply point'],
    [D('STORES-TEAM'), MAIN, 'Purchase & Stores runs the Main Store'],
    [D('KITCHEN'), KS, 'The kitchen uses the Kitchen Store'],
    [D('BAR'), LAYOVER, 'The bar team runs Layover; the Mini Bar is given in file 08'],
    [D('HOUSEKEEPING'), HK, 'Housekeeping keeps its store and the in-room minibars'],
  ],
);
csv(
  '04_location_settings.csv',
  ['org_node_code', 'latitude', 'longitude', 'geofence_radius_m'],
  [[H, '15.5961', '73.7676', '200']],
);

// ---------------------------------------------------------------------------------------
// People: one per job role
// ---------------------------------------------------------------------------------------

interface Person {
  user: string;
  name: string;
  role: string;
  home: string;
  pay: number;
}
const P = (user: string, name: string, role: string, dept: string | null, pay: number): Person => ({
  user: `passport.${user}`,
  name,
  role,
  home: dept === null ? H : dept === '(company)' ? CO : D(dept),
  pay,
});
const PEOPLE: Person[] = [
  P('owner', 'Vikram Desai', 'ACCOUNT_OWNER', '(company)', 250000),
  P('presenter', 'Demo Presenter', 'ACCOUNT_OWNER', '(company)', 1),
  P('gm', 'Anjali Fernandes', 'GENERAL_MANAGER', null, 160000),
  P('front-office-manager', "Rohan D'Souza", 'FRONT_OFFICE_MANAGER', 'FRONT-OFFICE', 65000),
  P('front-desk', 'Sneha Naik', 'FRONT_DESK_EXECUTIVE', 'FRONT-OFFICE', 28000),
  P('bell-captain', 'Joaquim Pereira', 'BELL_CAPTAIN', 'FRONT-OFFICE', 24000),
  P('executive-housekeeper', 'Maria Rodrigues', 'EXECUTIVE_HOUSEKEEPER', 'HOUSEKEEPING', 60000),
  P('housekeeping-supervisor', 'Pooja Gaonkar', 'HOUSEKEEPING_SUPERVISOR', 'HOUSEKEEPING', 32000),
  P('room-attendant', 'Savio Dias', 'ROOM_ATTENDANT', 'HOUSEKEEPING', 20000),
  P('public-area', 'Shanti Velip', 'PUBLIC_AREA_ATTENDANT', 'HOUSEKEEPING', 18000),
  P('laundry', 'Rekha Shirodkar', 'LAUNDRY_ATTENDANT', 'HOUSEKEEPING', 18000),
  P('pool', 'Nikhil Kerkar', 'POOL_ATTENDANT', 'HOUSEKEEPING', 21000),
  P('chef', 'Avinash Kamat', 'EXECUTIVE_CHEF', 'KITCHEN', 110000),
  P('sous-chef', 'Elton Gomes', 'SOUS_CHEF', 'KITCHEN', 55000),
  P('cdp', 'Priya Salgaonkar', 'CHEF_DE_PARTIE', 'KITCHEN', 35000),
  P('commis', 'Ganesh Parab', 'COMMIS', 'KITCHEN', 22000),
  P('steward', 'Raju Gawde', 'KITCHEN_STEWARD', 'KITCHEN', 17000),
  P('restaurant-manager', 'Clara Menezes', 'RESTAURANT_MANAGER', 'RESTAURANT', 62000),
  P('captain', 'Ashwin Prabhu', 'CAPTAIN', 'RESTAURANT', 30000),
  P('server', 'Kevin Noronha', 'SERVER', 'RESTAURANT', 20000),
  P('host', 'Tanvi Bhonsle', 'HOST', 'RESTAURANT', 22000),
  P('bar-manager', 'Dylan Coutinho', 'BAR_MANAGER', 'BAR', 70000),
  P('head-bartender', 'Ryan Mascarenhas', 'HEAD_BARTENDER', 'BAR', 42000),
  P('bartender', 'Aisha Khan', 'BARTENDER', 'BAR', 28000),
  P('bar-back', 'Suraj Mandrekar', 'BAR_BACK', 'BAR', 18000),
  P('ird', 'Nadia Fonseca', 'IRD_ORDER_TAKER', 'IN-ROOM-DINING', 22000),
  P('cashier', 'Kunal Sawant', 'CASHIER', 'CASHIER', 26000),
  P('chief-engineer', 'Prakash Chodankar', 'CHIEF_ENGINEER', 'ENGINEERING', 68000),
  P('technician', 'Vinay Harmalkar', 'TECHNICIAN', 'ENGINEERING', 24000),
  P('purchase-manager', 'Shreya Kenkre', 'PURCHASE_MANAGER', 'STORES-TEAM', 58000),
  P('store-keeper', 'Mahesh Talaulikar', 'STORE_KEEPER', 'STORES-TEAM', 30000),
  P('receiving', 'Sandeep Volvoikar', 'RECEIVING_CLERK', 'STORES-TEAM', 22000),
  P('accountant', 'Neha Sardesai', 'ACCOUNTANT', 'ADMIN-FINANCE', 48000),
  P('cost-controller', 'Rahul Bandodkar', 'COST_CONTROLLER', 'ADMIN-FINANCE', 52000),
  P('hr', 'Fatima Shaikh', 'HR_EXECUTIVE', 'ADMIN-FINANCE', 38000),
  P('sales-manager', 'Leon Almeida', 'SALES_MANAGER', 'BANQUETS', 72000),
  P('banquet-manager', 'Gail Lobo', 'BANQUET_MANAGER', 'BANQUETS', 60000),
  P('banquet-captain', 'Vishal Kudalkar', 'BANQUET_CAPTAIN', 'BANQUETS', 30000),
  P('banquet-server', 'Melissa Vaz', 'BANQUET_SERVER', 'BANQUETS', 19000),
];
const U = (user: string) => `passport.${user}`;

// catalogue roles by code alone (ADR 060); the hotel's own pool attendant in full
// IRD_MANAGER: the hotel has none; the Restaurant Manager covers it (file 37)
const roleCodes = [...new Set([...PEOPLE.map((p) => p.role), 'IRD_MANAGER'])];
csv(
  '06_job_roles.csv',
  ['job_role_code', 'job_title', 'outlet_format', 'usual_department', 'default_duties'],
  roleCodes.map((r) =>
    r === 'POOL_ATTENDANT'
      ? [r, 'Pool Attendant', 'any', 'HOUSEKEEPING', 'WORKS_SHIFTS; USES_DEPARTMENT_STORE']
      : [r, '', 'any', '', ''],
  ),
);
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
    day(-400 - i * 11),
    'test_rule',
    p.user === U('presenter') ? 'yes' : 'no',
  ]),
);
csv(
  '08_role_assignments_extra.csv',
  ['username', 'access_group', 'node_code', 'include_descendants', 'reason'],
  [
    [U('gm'), 'USER_ADMIN', H, 'true', 'The GM adds people and resets their passwords'],
    [U('bar-manager'), 'STORE_KEEPER', LOBBY, 'true', 'The bar team also runs the lobby Mini Bar'],
    [
      U('head-bartender'),
      'STORE_KEEPER',
      LOBBY,
      'true',
      'The bar team also runs the lobby Mini Bar',
    ],
    [U('bartender'), 'STOCK_USER', LOBBY, 'true', 'Works the lobby Mini Bar'],
    [U('bar-back'), 'STOCK_USER', LOBBY, 'true', 'Restocks the lobby Mini Bar'],
  ],
);
csv(
  '37_role_cover.csv',
  ['outlet_code', 'job_role_code', 'mode', 'covered_by_role'],
  [[H, 'IRD_MANAGER', 'covered_by', 'RESTAURANT_MANAGER']],
);

// ---------------------------------------------------------------------------------------
// Suppliers, items and where they are kept
// ---------------------------------------------------------------------------------------

csv(
  '09_suppliers.csv',
  ['supplier_code', 'name', 'lead_time_days', 'contact_email', 'contact_phone'],
  [
    [
      'SUP-PRODUCE',
      'Mapusa Market Produce (demo)',
      1,
      'produce@demo-supplier.example',
      '+91 98220 10001',
    ],
    [
      'SUP-SEAFOOD',
      'Chapora Fresh Catch (demo)',
      1,
      'catch@demo-supplier.example',
      '+91 98220 10002',
    ],
    [
      'SUP-MEAT',
      'Assagao Meats & Chouriço (demo)',
      1,
      'meats@demo-supplier.example',
      '+91 98220 10003',
    ],
    [
      'SUP-DAIRY',
      'Siolim Dairy & Eggs (demo)',
      1,
      'dairy@demo-supplier.example',
      '+91 98220 10004',
    ],
    [
      'SUP-POI',
      'Village Poder – poi & pao (demo)',
      1,
      'poder@demo-supplier.example',
      '+91 98220 10005',
    ],
    [
      'SUP-GROCERY',
      'Mapusa Wholesale Grocers (demo)',
      2,
      'grocery@demo-supplier.example',
      '+91 98220 10006',
    ],
    [
      'SUP-SPIRITS',
      'Coastal Wines & Spirits (demo)',
      2,
      'spirits@demo-supplier.example',
      '+91 98220 10007',
    ],
    [
      'SUP-HOTEL',
      'Konkan Hotel Supplies (demo)',
      3,
      'hotel@demo-supplier.example',
      '+91 98220 10008',
    ],
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
}
const I = (
  code: string,
  name: string,
  cat: string,
  unit: string,
  perishable: boolean,
  cost: number,
  sup: string,
  conv?: ['g' | 'ml' | 'each', number],
): Item => ({ code, name, cat, unit, perishable, cost, sup, ...(conv ? { conv } : {}) });
const KG: ['g', number] = ['g', 1000];
const LT: ['ml', number] = ['ml', 1000];
const BOTTLE: ['ml', number] = ['ml', 750];
const ITEMS: Item[] = [
  // seafood and meat
  I('KINGFISH', 'Kingfish (surmai)', 'Seafood', 'kg', true, 900, 'SUP-SEAFOOD', KG),
  I('PRAWNS', 'Prawns, medium', 'Seafood', 'kg', true, 650, 'SUP-SEAFOOD', KG),
  I('CLAMS', 'Clams (tisreo)', 'Seafood', 'kg', true, 220, 'SUP-SEAFOOD', KG),
  I('SQUID', 'Squid', 'Seafood', 'kg', true, 420, 'SUP-SEAFOOD', KG),
  I('CHICKEN', 'Chicken, curry cut', 'Meat', 'kg', true, 260, 'SUP-MEAT', KG),
  I('PORK-BELLY', 'Pork belly', 'Meat', 'kg', true, 480, 'SUP-MEAT', KG),
  I('CHOURICO', 'Goan chouriço', 'Meat', 'kg', true, 900, 'SUP-MEAT', KG),
  // dairy, eggs, bread
  I('EGGS', 'Eggs', 'Dairy & eggs', 'each', true, 7, 'SUP-DAIRY'),
  I('BUTTER', 'Butter', 'Dairy & eggs', 'kg', true, 520, 'SUP-DAIRY', KG),
  I('MILK', 'Milk', 'Dairy & eggs', 'l', true, 60, 'SUP-DAIRY', LT),
  I('CHEESE', 'Cheddar cheese', 'Dairy & eggs', 'kg', true, 650, 'SUP-DAIRY', KG),
  I('POI', 'Poi (Goan bread)', 'Bakery', 'each', true, 8, 'SUP-POI'),
  I('PAO', 'Pao', 'Bakery', 'each', true, 6, 'SUP-POI'),
  I('SANDWICH-BREAD', 'Sandwich bread, slice', 'Bakery', 'each', true, 3, 'SUP-POI'),
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
  I('PINEAPPLE', 'Pineapple', 'Produce', 'kg', true, 60, 'SUP-PRODUCE', KG),
  I('MUSKMELON', 'Muskmelon', 'Produce', 'kg', true, 50, 'SUP-PRODUCE', KG),
  // grocery and spices
  I('RED-RICE', 'Goan red rice (ukde)', 'Grocery', 'kg', false, 90, 'SUP-GROCERY', KG),
  I('FLOUR', 'Flour (maida)', 'Grocery', 'kg', false, 45, 'SUP-GROCERY', KG),
  I('SEMOLINA', 'Semolina (rava)', 'Grocery', 'kg', false, 50, 'SUP-GROCERY', KG),
  I('SUGAR', 'Sugar', 'Grocery', 'kg', false, 45, 'SUP-GROCERY', KG),
  I('JAGGERY', 'Palm jaggery', 'Grocery', 'kg', false, 160, 'SUP-GROCERY', KG),
  I('COCONUT-MILK', 'Coconut milk', 'Grocery', 'l', false, 180, 'SUP-GROCERY', LT),
  I('OIL', 'Sunflower oil', 'Grocery', 'l', false, 150, 'SUP-GROCERY', LT),
  I('COCONUT-OIL', 'Coconut oil', 'Grocery', 'l', false, 260, 'SUP-GROCERY', LT),
  I('TODDY-VINEGAR', 'Toddy vinegar', 'Grocery', 'l', false, 120, 'SUP-GROCERY', LT),
  I('KOKUM', 'Kokum, dried', 'Grocery', 'kg', false, 300, 'SUP-GROCERY', KG),
  I('TAMARIND', 'Tamarind', 'Grocery', 'kg', false, 140, 'SUP-GROCERY', KG),
  I('KASHMIRI-CHILLI', 'Kashmiri chilli, dried', 'Spices', 'kg', false, 650, 'SUP-GROCERY', KG),
  I('CUMIN', 'Cumin', 'Spices', 'kg', false, 450, 'SUP-GROCERY', KG),
  I('TURMERIC', 'Turmeric', 'Spices', 'kg', false, 260, 'SUP-GROCERY', KG),
  I('BLACK-PEPPER', 'Black pepper', 'Spices', 'kg', false, 900, 'SUP-GROCERY', KG),
  I('CINNAMON', 'Cinnamon', 'Spices', 'kg', false, 800, 'SUP-GROCERY', KG),
  I('CLOVES', 'Cloves', 'Spices', 'kg', false, 1400, 'SUP-GROCERY', KG),
  I('SALT', 'Salt', 'Grocery', 'kg', false, 20, 'SUP-GROCERY', KG),
  I('FRIES', 'French fries, frozen', 'Grocery', 'kg', true, 140, 'SUP-GROCERY', KG),
  I('NACHOS', 'Nacho chips', 'Grocery', 'kg', false, 300, 'SUP-GROCERY', KG),
  I('ESPRESSO-BEANS', 'Espresso beans', 'Grocery', 'kg', false, 1400, 'SUP-GROCERY', KG),
  I('HIBISCUS', 'Hibiscus, dried', 'Grocery', 'kg', false, 600, 'SUP-GROCERY', KG),
  I('ICE', 'Ice', 'Bar', 'kg', true, 15, 'SUP-GROCERY', KG),
  // spirits, beer and wine
  I('FENI-750ML', 'Cashew feni 750ml', 'Spirits', 'bottle', false, 650, 'SUP-SPIRITS', BOTTLE),
  I(
    'TEQUILA-750ML',
    'Tequila blanco 750ml',
    'Spirits',
    'bottle',
    false,
    3200,
    'SUP-SPIRITS',
    BOTTLE,
  ),
  I('GIN-750ML', 'Indian craft gin 750ml', 'Spirits', 'bottle', false, 1800, 'SUP-SPIRITS', BOTTLE),
  I('VODKA-750ML', 'Vodka 750ml', 'Spirits', 'bottle', false, 1500, 'SUP-SPIRITS', BOTTLE),
  I('WHITE-RUM-750ML', 'White rum 750ml', 'Spirits', 'bottle', false, 800, 'SUP-SPIRITS', BOTTLE),
  I('DARK-RUM-750ML', 'Dark rum 750ml', 'Spirits', 'bottle', false, 700, 'SUP-SPIRITS', BOTTLE),
  I('BOURBON-750ML', 'Bourbon 750ml', 'Spirits', 'bottle', false, 3500, 'SUP-SPIRITS', BOTTLE),
  I(
    'COFFEE-LIQUEUR-750ML',
    'Coffee liqueur 750ml',
    'Spirits',
    'bottle',
    false,
    1600,
    'SUP-SPIRITS',
    BOTTLE,
  ),
  I(
    'VERMOUTH-750ML',
    'Sweet vermouth 750ml',
    'Spirits',
    'bottle',
    false,
    1400,
    'SUP-SPIRITS',
    BOTTLE,
  ),
  I(
    'APERITIF-750ML',
    'Bitter aperitif 750ml',
    'Spirits',
    'bottle',
    false,
    1800,
    'SUP-SPIRITS',
    BOTTLE,
  ),
  I('BITTERS-200ML', 'Aromatic bitters 200ml', 'Spirits', 'bottle', false, 1100, 'SUP-SPIRITS', [
    'ml',
    200,
  ]),
  I('LAGER-330ML', 'Lager 330ml', 'Beer', 'bottle', false, 90, 'SUP-SPIRITS'),
  I('CRAFT-BEER-330ML', 'Goan craft beer 330ml', 'Beer', 'can', false, 160, 'SUP-SPIRITS'),
  I('RED-WINE-750ML', 'Red wine 750ml', 'Wine', 'bottle', false, 900, 'SUP-SPIRITS', BOTTLE),
  I('WHITE-WINE-750ML', 'White wine 750ml', 'Wine', 'bottle', false, 900, 'SUP-SPIRITS', BOTTLE),
  I('TONIC-200ML', 'Tonic water 200ml', 'Mixers', 'can', false, 45, 'SUP-SPIRITS', ['ml', 200]),
  I('SODA-750ML', 'Soda 750ml', 'Mixers', 'bottle', false, 25, 'SUP-SPIRITS', BOTTLE),
  I('COLA-300ML', 'Cola 300ml', 'Mixers', 'can', false, 35, 'SUP-SPIRITS'),
  // in-room minibar
  I('WATER-1L', 'Mineral water 1l', 'Minibar', 'bottle', false, 20, 'SUP-GROCERY'),
  I('CASHEWS-100G', 'Goan cashews 100g', 'Minibar', 'pack', false, 140, 'SUP-GROCERY'),
  I('CHIPS-PACK', 'Banana chips pack', 'Minibar', 'pack', false, 40, 'SUP-GROCERY'),
  I('CHOCOLATE-BAR', 'Chocolate bar', 'Minibar', 'each', false, 80, 'SUP-GROCERY'),
  I('FENI-NIP-180ML', 'Feni nip 180ml', 'Minibar', 'bottle', false, 170, 'SUP-SPIRITS'),
  // housekeeping and pool
  I('BATH-TOWEL', 'Bath towel', 'Linen', 'each', false, 450, 'SUP-HOTEL'),
  I('POOL-TOWEL', 'Pool towel', 'Linen', 'each', false, 380, 'SUP-HOTEL'),
  I('BEDSHEET-KING', 'Bedsheet, king', 'Linen', 'each', false, 900, 'SUP-HOTEL'),
  I('SHAMPOO-30ML', 'Shampoo 30ml', 'Amenities', 'each', false, 18, 'SUP-HOTEL'),
  I('SOAP-40G', 'Soap bar 40g', 'Amenities', 'each', false, 14, 'SUP-HOTEL'),
  I('DENTAL-KIT', 'Dental kit', 'Amenities', 'each', false, 22, 'SUP-HOTEL'),
  I('TOILET-ROLL', 'Toilet roll', 'Amenities', 'each', false, 25, 'SUP-HOTEL'),
  I('POOL-CHLORINE', 'Pool chlorine granules', 'Pool', 'kg', false, 180, 'SUP-HOTEL'),
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
  ],
  ITEMS.map((i) => [i.code, i.name, i.cat, i.unit, i.perishable ? 'yes' : 'no', i.cost, i.sup]),
);
csv(
  '18_item_unit_conversions.csv',
  ['item_code', 'stock_unit', 'recipe_unit', 'recipe_units_per_stock_unit'],
  ITEMS.filter((i) => i.conv).map((i) => [i.code, i.unit, i.conv![0], i.conv![1]]),
);

// where each item is kept, with par (in stock units) and a shelf for the bar count sheets
const KITCHEN_ITEMS: [string, number][] = [
  ['KINGFISH', 8],
  ['PRAWNS', 10],
  ['CLAMS', 6],
  ['SQUID', 5],
  ['CHICKEN', 15],
  ['PORK-BELLY', 6],
  ['CHOURICO', 4],
  ['EGGS', 360],
  ['BUTTER', 5],
  ['MILK', 20],
  ['CHEESE', 3],
  ['POI', 120],
  ['PAO', 60],
  ['SANDWICH-BREAD', 80],
  ['ONIONS', 30],
  ['TOMATOES', 20],
  ['POTATOES', 25],
  ['GREEN-CHILLIES', 3],
  ['GINGER', 3],
  ['GARLIC', 4],
  ['CORIANDER', 2],
  ['LIMES', 120],
  ['COCONUT', 40],
  ['PINEAPPLE', 10],
  ['MUSKMELON', 8],
  ['RED-RICE', 25],
  ['FLOUR', 15],
  ['SEMOLINA', 8],
  ['SUGAR', 15],
  ['JAGGERY', 4],
  ['COCONUT-MILK', 12],
  ['OIL', 20],
  ['COCONUT-OIL', 8],
  ['TODDY-VINEGAR', 6],
  ['KOKUM', 1],
  ['TAMARIND', 2],
  ['KASHMIRI-CHILLI', 2],
  ['CUMIN', 1],
  ['TURMERIC', 1],
  ['BLACK-PEPPER', 0.5],
  ['CINNAMON', 0.5],
  ['CLOVES', 0.3],
  ['SALT', 10],
  ['FRIES', 15],
  ['NACHOS', 4],
];
const BAR_ITEMS: [string, number, string][] = [
  ['FENI-750ML', 12, 'Back bar'],
  ['TEQUILA-750ML', 6, 'Back bar'],
  ['GIN-750ML', 8, 'Back bar'],
  ['VODKA-750ML', 6, 'Back bar'],
  ['WHITE-RUM-750ML', 6, 'Back bar'],
  ['DARK-RUM-750ML', 6, 'Back bar'],
  ['BOURBON-750ML', 4, 'Back bar'],
  ['COFFEE-LIQUEUR-750ML', 3, 'Back bar'],
  ['VERMOUTH-750ML', 3, 'Back bar'],
  ['APERITIF-750ML', 3, 'Back bar'],
  ['BITTERS-200ML', 2, 'Back bar'],
  ['LAGER-330ML', 96, 'Beer fridge'],
  ['CRAFT-BEER-330ML', 48, 'Beer fridge'],
  ['RED-WINE-750ML', 12, 'Wine rack'],
  ['WHITE-WINE-750ML', 12, 'Wine rack'],
  ['TONIC-200ML', 72, 'Mixer fridge'],
  ['SODA-750ML', 36, 'Mixer fridge'],
  ['COLA-300ML', 48, 'Mixer fridge'],
  ['LIMES', 120, 'Garnish fridge'],
  ['MINT', 1, 'Garnish fridge'],
  ['GREEN-CHILLIES', 1, 'Garnish fridge'],
  ['PINEAPPLE', 8, 'Garnish fridge'],
  ['MUSKMELON', 6, 'Garnish fridge'],
  ['SUGAR', 6, 'Dry shelf'],
  ['JAGGERY', 2, 'Dry shelf'],
  ['SALT', 2, 'Dry shelf'],
  ['TODDY-VINEGAR', 2, 'Dry shelf'],
  ['ESPRESSO-BEANS', 2, 'Dry shelf'],
  ['HIBISCUS', 0.5, 'Dry shelf'],
  ['GARLIC', 0.5, 'Dry shelf'],
  ['CINNAMON', 0.2, 'Dry shelf'],
  ['ICE', 60, 'Ice machine'],
];
// the lobby Mini Bar pours the signatures and a few classics: no beer, wine or rum
const LOBBY_SKIP = new Set([
  'LAGER-330ML',
  'CRAFT-BEER-330ML',
  'RED-WINE-750ML',
  'WHITE-WINE-750ML',
  'WHITE-RUM-750ML',
  'COLA-300ML',
  'MINT',
]);
const HK_ITEMS: [string, number][] = [
  ['WATER-1L', 120],
  ['COLA-300ML', 60],
  ['LAGER-330ML', 60],
  ['CASHEWS-100G', 40],
  ['CHIPS-PACK', 40],
  ['CHOCOLATE-BAR', 40],
  ['FENI-NIP-180ML', 20],
  ['BATH-TOWEL', 120],
  ['POOL-TOWEL', 80],
  ['BEDSHEET-KING', 90],
  ['SHAMPOO-30ML', 300],
  ['SOAP-40G', 300],
  ['DENTAL-KIT', 200],
  ['TOILET-ROLL', 250],
  ['POOL-CHLORINE', 25],
];
const MAIN_ITEMS: [string, number][] = [
  ['RED-RICE', 100],
  ['FLOUR', 50],
  ['SUGAR', 50],
  ['OIL', 60],
  ['COCONUT-OIL', 20],
  ['FENI-750ML', 24],
  ['GIN-750ML', 18],
  ['VODKA-750ML', 12],
  ['TEQUILA-750ML', 12],
  ['BOURBON-750ML', 6],
  ['LAGER-330ML', 240],
  ['TONIC-200ML', 144],
  ['WATER-1L', 300],
  ['SHAMPOO-30ML', 600],
  ['SOAP-40G', 600],
  ['TOILET-ROLL', 400],
  ['CASHEWS-100G', 60],
];
type Loc = { item: string; store: string; par: number; shelf?: string; order?: number };
const LOCS: Loc[] = [
  ...KITCHEN_ITEMS.map(([item, par]) => ({ item, store: KS, par })),
  ...BAR_ITEMS.map(([item, par, shelf], i) => ({ item, store: LAYOVER, par, shelf, order: i })),
  ...BAR_ITEMS.filter(([item]) => !LOBBY_SKIP.has(item)).map(([item, par, shelf], i) => ({
    item,
    store: LOBBY,
    par: Math.max(Math.round(par * 0.5 * 10) / 10, 0.5),
    shelf,
    order: i,
  })),
  ...HK_ITEMS.map(([item, par]) => ({ item, store: HK, par })),
  ...MAIN_ITEMS.map(([item, par]) => ({ item, store: MAIN, par })),
];
const KEPT = new Set(LOCS.map((l) => `${l.item} ${l.store}`));
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
// Menus: their Mini Bar signatures (from the hotel), the rest invented for the demo
// ---------------------------------------------------------------------------------------

type Line = [code: string, qty: number, unit: 'g' | 'ml' | 'each', kind?: 'prep'];
interface Prep {
  code: string;
  name: string;
  type: 'kitchen_prep' | 'house_mixer' | 'batched_cocktail';
  unit: 'g' | 'ml';
  yield: number;
  life: number;
  at: string[];
  par: number;
  lines: Line[];
  steps: [string, number][];
}
const PREPS: Prep[] = [
  {
    code: 'SUGAR-SYRUP',
    name: 'Sugar syrup',
    type: 'house_mixer',
    unit: 'ml',
    yield: 1000,
    life: 336,
    at: [LAYOVER, LOBBY],
    par: 1500,
    lines: [['SUGAR', 650, 'g']],
    steps: [['Dissolve the sugar in 500 ml of hot water; cool and bottle.', 15]],
  },
  {
    code: 'TEPACHE-LIQUEUR',
    name: 'Pineapple tepache liqueur',
    type: 'house_mixer',
    unit: 'ml',
    yield: 1000,
    life: 240,
    at: [LAYOVER, LOBBY],
    par: 1000,
    lines: [
      ['PINEAPPLE', 800, 'g'],
      ['JAGGERY', 150, 'g'],
      ['CINNAMON', 3, 'g'],
      ['FENI-750ML', 250, 'ml'],
    ],
    steps: [
      ['Ferment pineapple skins and cores with jaggery and cinnamon for 3 days.', 20],
      ['Strain, fortify with feni and bottle.', 15],
    ],
  },
  {
    code: 'THECHA-SALT',
    name: 'Green chilli thecha salt',
    type: 'house_mixer',
    unit: 'g',
    yield: 250,
    life: 336,
    at: [LAYOVER, LOBBY],
    par: 250,
    lines: [
      ['GREEN-CHILLIES', 80, 'g'],
      ['GARLIC', 20, 'g'],
      ['SALT', 200, 'g'],
    ],
    steps: [['Pound chillies and garlic to a coarse thecha; dry with the salt at low heat.', 30]],
  },
  {
    code: 'COLD-BREW',
    name: 'Cold brew coffee',
    type: 'house_mixer',
    unit: 'ml',
    yield: 1000,
    life: 72,
    at: [LAYOVER, LOBBY],
    par: 1000,
    lines: [['ESPRESSO-BEANS', 120, 'g']],
    steps: [['Coarse-grind the beans; steep in cold water for 16 hours; strain.', 10]],
  },
  {
    code: 'MUSKMELON-SHRUB',
    name: 'Muskmelon shrub',
    type: 'house_mixer',
    unit: 'ml',
    yield: 750,
    life: 168,
    at: [LAYOVER, LOBBY],
    par: 750,
    lines: [
      ['MUSKMELON', 600, 'g'],
      ['SUGAR', 200, 'g'],
      ['TODDY-VINEGAR', 150, 'ml'],
    ],
    steps: [['Macerate melon with sugar overnight; strain and add toddy vinegar.', 20]],
  },
  {
    code: 'HIBISCUS-SYRUP',
    name: 'Hibiscus syrup',
    type: 'house_mixer',
    unit: 'ml',
    yield: 750,
    life: 240,
    at: [LAYOVER, LOBBY],
    par: 750,
    lines: [
      ['HIBISCUS', 30, 'g'],
      ['SUGAR', 450, 'g'],
    ],
    steps: [['Steep hibiscus in hot water; strain and dissolve the sugar.', 20]],
  },
  {
    code: 'RECHEADO-MASALA',
    name: 'Recheado masala',
    type: 'kitchen_prep',
    unit: 'g',
    yield: 1000,
    life: 336,
    at: [KS],
    par: 1000,
    lines: [
      ['KASHMIRI-CHILLI', 200, 'g'],
      ['GARLIC', 120, 'g'],
      ['GINGER', 60, 'g'],
      ['CUMIN', 20, 'g'],
      ['CINNAMON', 10, 'g'],
      ['CLOVES', 5, 'g'],
      ['TAMARIND', 60, 'g'],
      ['TODDY-VINEGAR', 400, 'ml'],
      ['SUGAR', 40, 'g'],
    ],
    steps: [
      ['Soak the chillies in the vinegar for 2 hours.', 10],
      ['Grind everything to a smooth, thick paste; jar and refrigerate.', 20],
    ],
  },
  {
    code: 'XACUTI-MASALA',
    name: 'Xacuti masala',
    type: 'kitchen_prep',
    unit: 'g',
    yield: 1000,
    life: 120,
    at: [KS],
    par: 1000,
    lines: [
      ['COCONUT', 3, 'each'],
      ['KASHMIRI-CHILLI', 80, 'g'],
      ['ONIONS', 300, 'g'],
      ['BLACK-PEPPER', 15, 'g'],
      ['CINNAMON', 8, 'g'],
      ['CLOVES', 4, 'g'],
      ['TURMERIC', 10, 'g'],
      ['COCONUT-OIL', 60, 'ml'],
    ],
    steps: [
      ['Roast grated coconut and onions until deep brown.', 25],
      ['Roast the spices; grind everything with water to a paste.', 20],
    ],
  },
  {
    code: 'GOAN-CURRY-BASE',
    name: 'Goan coconut curry base',
    type: 'kitchen_prep',
    unit: 'ml',
    yield: 3000,
    life: 72,
    at: [KS],
    par: 3000,
    lines: [
      ['COCONUT-MILK', 1500, 'ml'],
      ['ONIONS', 400, 'g'],
      ['TOMATOES', 300, 'g'],
      ['KASHMIRI-CHILLI', 40, 'g'],
      ['TURMERIC', 10, 'g'],
      ['KOKUM', 30, 'g'],
      ['COCONUT-OIL', 80, 'ml'],
      ['SALT', 30, 'g'],
    ],
    steps: [
      ['Sweat onions in coconut oil; add tomatoes and the ground chilli and turmeric.', 20],
      ['Add coconut milk and kokum; simmer without boiling.', 25],
    ],
  },
];
const PREP = new Map(PREPS.map((p) => [p.code, p]));
csv(
  '19_prep_items.csv',
  ['prep_item_code', 'name', 'prep_type', 'unit', 'batch_yield', 'shelf_life_hours'],
  PREPS.map((p) => [p.code, p.name, p.type, p.unit, p.yield, p.life]),
);
csv(
  '20_prep_locations.csv',
  ['prep_item_code', 'store_node_code', 'made_here', 'par_level'],
  PREPS.flatMap((p) => p.at.map((s) => [p.code, s, 'yes', p.par])),
);
csv(
  '24_prep_procedures.csv',
  ['prep_item_code', 'step', 'instruction', 'minutes'],
  PREPS.flatMap((p) => p.steps.map(([t, m], i) => [p.code, i + 1, t, m])),
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
  store: string,
  price: number,
  sells: [number, number],
  lines: Line[],
): Dish => ({ code, name, menu, cat, serving, store, price, sells, lines });
const P_ = 'prep' as const;
const DISHES: Dish[] = [
  // Mini Bar (lobby): the hotel's signatures
  dish(
    'PASSPORT-DE-PICANTE',
    'Passport De Picante',
    'Bar',
    'Mini Bar signatures',
    '1 glass',
    LOBBY,
    650,
    [4, 9],
    [
      ['TEQUILA-750ML', 50, 'ml'],
      ['PINEAPPLE', 60, 'g'],
      ['GREEN-CHILLIES', 4, 'g'],
      ['LIMES', 1, 'each'],
      ['SUGAR-SYRUP', 15, 'ml', P_],
      ['ICE', 150, 'g'],
    ],
  ),
  dish(
    'MADAME-ROSITA',
    'Madame Rosita',
    'Bar',
    'Mini Bar signatures',
    '1 glass',
    LOBBY,
    600,
    [3, 8],
    [
      ['GIN-750ML', 45, 'ml'],
      ['HIBISCUS-SYRUP', 20, 'ml', P_],
      ['LIMES', 1, 'each'],
      ['SODA-750ML', 60, 'ml'],
      ['ICE', 150, 'g'],
    ],
  ),
  // the hotel's own spec: feni, tequila blanco, tepache liqueur, green chillies, thecha salt rim
  dish(
    'HOT-GIRL-CLUB',
    'Hot Girl Club',
    'Bar',
    'Mini Bar signatures',
    '1 glass',
    LOBBY,
    650,
    [6, 12],
    [
      ['FENI-750ML', 30, 'ml'],
      ['TEQUILA-750ML', 30, 'ml'],
      ['TEPACHE-LIQUEUR', 30, 'ml', P_],
      ['GREEN-CHILLIES', 5, 'g'],
      ['THECHA-SALT', 3, 'g', P_],
      ['LIMES', 1, 'each'],
      ['ICE', 150, 'g'],
    ],
  ),
  dish(
    'CAFE-NOIR',
    'Café Noir',
    'Bar',
    'Mini Bar signatures',
    '1 glass',
    LOBBY,
    600,
    [3, 7],
    [
      ['DARK-RUM-750ML', 40, 'ml'],
      ['COFFEE-LIQUEUR-750ML', 20, 'ml'],
      ['COLD-BREW', 40, 'ml', P_],
      ['SUGAR-SYRUP', 10, 'ml', P_],
      ['ICE', 120, 'g'],
    ],
  ),
  // a muskmelon twist on an Old Fashioned
  dish(
    'MELONI',
    'Meloni',
    'Bar',
    'Mini Bar signatures',
    '1 glass',
    LOBBY,
    700,
    [3, 8],
    [
      ['BOURBON-750ML', 50, 'ml'],
      ['MUSKMELON-SHRUB', 20, 'ml', P_],
      ['BITTERS-200ML', 2, 'ml'],
      ['ICE', 100, 'g'],
    ],
  ),
  dish(
    'FENI-TONIC',
    'Feni & tonic',
    'Bar',
    'Mini Bar classics',
    '1 glass',
    LOBBY,
    450,
    [4, 10],
    [
      ['FENI-750ML', 45, 'ml'],
      ['TONIC-200ML', 150, 'ml'],
      ['LIMES', 1, 'each'],
      ['ICE', 150, 'g'],
    ],
  ),
  dish(
    'NEGRONI',
    'Negroni',
    'Bar',
    'Mini Bar classics',
    '1 glass',
    LOBBY,
    600,
    [2, 6],
    [
      ['GIN-750ML', 30, 'ml'],
      ['VERMOUTH-750ML', 30, 'ml'],
      ['APERITIF-750ML', 30, 'ml'],
      ['ICE', 100, 'g'],
    ],
  ),
  // Layover (rooftop) bar
  dish(
    'LAYOVER-MOJITO',
    'Mojito',
    'Bar',
    'Layover cocktails',
    '1 glass',
    LAYOVER,
    500,
    [5, 12],
    [
      ['WHITE-RUM-750ML', 60, 'ml'],
      ['MINT', 8, 'g'],
      ['LIMES', 1, 'each'],
      ['SUGAR-SYRUP', 20, 'ml', P_],
      ['SODA-750ML', 90, 'ml'],
      ['ICE', 200, 'g'],
    ],
  ),
  dish(
    'LAYOVER-GT',
    'Gin & tonic',
    'Bar',
    'Layover cocktails',
    '1 glass',
    LAYOVER,
    550,
    [5, 11],
    [
      ['GIN-750ML', 60, 'ml'],
      ['TONIC-200ML', 200, 'ml'],
      ['LIMES', 1, 'each'],
      ['ICE', 150, 'g'],
    ],
  ),
  dish(
    'LAYOVER-ESPRESSO-MARTINI',
    'Espresso martini',
    'Bar',
    'Layover cocktails',
    '1 glass',
    LAYOVER,
    600,
    [3, 8],
    [
      ['VODKA-750ML', 45, 'ml'],
      ['COFFEE-LIQUEUR-750ML', 20, 'ml'],
      ['COLD-BREW', 30, 'ml', P_],
      ['SUGAR-SYRUP', 10, 'ml', P_],
      ['ICE', 120, 'g'],
    ],
  ),
  dish(
    'LAYOVER-HOT-GIRL-CLUB',
    'Hot Girl Club (Layover)',
    'Bar',
    'Layover cocktails',
    '1 glass',
    LAYOVER,
    650,
    [4, 9],
    [
      ['FENI-750ML', 30, 'ml'],
      ['TEQUILA-750ML', 30, 'ml'],
      ['TEPACHE-LIQUEUR', 30, 'ml', P_],
      ['GREEN-CHILLIES', 5, 'g'],
      ['THECHA-SALT', 3, 'g', P_],
      ['LIMES', 1, 'each'],
      ['ICE', 150, 'g'],
    ],
  ),
  dish(
    'LAGER-BOTTLE',
    'Lager, bottle',
    'Bar',
    'Beer',
    '1 bottle',
    LAYOVER,
    250,
    [10, 24],
    [['LAGER-330ML', 1, 'each']],
  ),
  dish(
    'CRAFT-BEER',
    'Goan craft beer',
    'Bar',
    'Beer',
    '1 can',
    LAYOVER,
    350,
    [6, 15],
    [['CRAFT-BEER-330ML', 1, 'each']],
  ),
  dish(
    'RED-WINE-GLASS',
    'House red, glass',
    'Bar',
    'Wine',
    '150 ml',
    LAYOVER,
    450,
    [3, 8],
    [['RED-WINE-750ML', 150, 'ml']],
  ),
  dish(
    'WHITE-WINE-GLASS',
    'House white, glass',
    'Bar',
    'Wine',
    '150 ml',
    LAYOVER,
    450,
    [3, 8],
    [['WHITE-WINE-750ML', 150, 'ml']],
  ),
  dish(
    'FRESH-LIME-SODA',
    'Fresh lime soda (pool)',
    'Bar',
    'Pool drinks',
    '1 glass',
    LAYOVER,
    180,
    [8, 18],
    [
      ['LIMES', 1, 'each'],
      ['SUGAR-SYRUP', 25, 'ml', P_],
      ['SODA-750ML', 250, 'ml'],
      ['ICE', 100, 'g'],
    ],
  ),
  // Breakfast (restaurant)
  dish(
    'ROS-OMELETTE',
    'Ros omelette with poi',
    'Food',
    'Breakfast',
    '1 plate',
    KS,
    380,
    [8, 16],
    [
      ['EGGS', 3, 'each'],
      ['POI', 2, 'each'],
      ['XACUTI-MASALA', 60, 'g', P_],
      ['CHICKEN', 80, 'g'],
      ['ONIONS', 30, 'g'],
      ['BUTTER', 10, 'g'],
    ],
  ),
  dish(
    'CHOURICO-PAO',
    'Chouriço pao',
    'Food',
    'Breakfast',
    '2 pao',
    KS,
    340,
    [4, 10],
    [
      ['CHOURICO', 120, 'g'],
      ['PAO', 2, 'each'],
      ['ONIONS', 40, 'g'],
      ['GREEN-CHILLIES', 5, 'g'],
    ],
  ),
  dish(
    'BHAJI-PAO',
    'Goan bhaji pao',
    'Food',
    'Breakfast',
    '1 plate',
    KS,
    260,
    [4, 9],
    [
      ['POTATOES', 180, 'g'],
      ['ONIONS', 50, 'g'],
      ['COCONUT', 0.1, 'each'],
      ['PAO', 2, 'each'],
      ['TURMERIC', 2, 'g'],
      ['OIL', 15, 'ml'],
    ],
  ),
  dish(
    'FRUIT-PLATE',
    'Fresh fruit plate',
    'Food',
    'Breakfast',
    '1 plate',
    KS,
    280,
    [5, 12],
    [
      ['PINEAPPLE', 150, 'g'],
      ['MUSKMELON', 150, 'g'],
      ['LIMES', 0.5, 'each'],
    ],
  ),
  // Layover kitchen
  dish(
    'PRAWN-RECHEADO',
    'Prawns recheado',
    'Food',
    'Layover small plates',
    '1 plate',
    KS,
    650,
    [5, 12],
    [
      ['PRAWNS', 200, 'g'],
      ['RECHEADO-MASALA', 40, 'g', P_],
      ['OIL', 20, 'ml'],
      ['LIMES', 0.5, 'each'],
    ],
  ),
  dish(
    'CALAMARI',
    'Calamari, rava fried',
    'Food',
    'Layover small plates',
    '1 plate',
    KS,
    520,
    [4, 10],
    [
      ['SQUID', 180, 'g'],
      ['SEMOLINA', 40, 'g'],
      ['FLOUR', 20, 'g'],
      ['OIL', 60, 'ml'],
      ['LIMES', 0.5, 'each'],
    ],
  ),
  dish(
    'CHICKEN-CAFREAL',
    'Chicken cafreal',
    'Food',
    'Layover small plates',
    '1 plate',
    KS,
    520,
    [4, 10],
    [
      ['CHICKEN', 250, 'g'],
      ['CORIANDER', 30, 'g'],
      ['GREEN-CHILLIES', 15, 'g'],
      ['GINGER', 10, 'g'],
      ['GARLIC', 10, 'g'],
      ['LIMES', 1, 'each'],
      ['OIL', 20, 'ml'],
    ],
  ),
  dish(
    'CHOURICO-NACHOS',
    'Chouriço nachos',
    'Food',
    'Layover small plates',
    '1 plate',
    KS,
    480,
    [4, 9],
    [
      ['NACHOS', 120, 'g'],
      ['CHOURICO', 60, 'g'],
      ['CHEESE', 50, 'g'],
      ['TOMATOES', 40, 'g'],
    ],
  ),
  dish(
    'KINGFISH-RAVA-FRY',
    'Kingfish rava fry',
    'Food',
    'Layover mains',
    '1 plate',
    KS,
    780,
    [3, 8],
    [
      ['KINGFISH', 220, 'g'],
      ['SEMOLINA', 40, 'g'],
      ['RECHEADO-MASALA', 20, 'g', P_],
      ['OIL', 40, 'ml'],
      ['LIMES', 0.5, 'each'],
    ],
  ),
  dish(
    'PRAWN-CURRY-RICE',
    'Goan prawn curry & red rice',
    'Food',
    'Layover mains',
    '1 plate',
    KS,
    720,
    [5, 11],
    [
      ['PRAWNS', 150, 'g'],
      ['GOAN-CURRY-BASE', 250, 'ml', P_],
      ['RED-RICE', 150, 'g'],
    ],
  ),
  dish(
    'PORK-VINDALHO',
    'Pork vindalho & poi',
    'Food',
    'Layover mains',
    '1 plate',
    KS,
    680,
    [3, 8],
    [
      ['PORK-BELLY', 220, 'g'],
      ['RECHEADO-MASALA', 50, 'g', P_],
      ['ONIONS', 60, 'g'],
      ['TODDY-VINEGAR', 20, 'ml'],
      ['POI', 2, 'each'],
    ],
  ),
  dish(
    'TISREO-SUKHEM',
    'Tisreo sukhem (clams)',
    'Food',
    'Layover small plates',
    '1 plate',
    KS,
    480,
    [2, 6],
    [
      ['CLAMS', 250, 'g'],
      ['COCONUT', 0.25, 'each'],
      ['ONIONS', 50, 'g'],
      ['TURMERIC', 2, 'g'],
      ['KASHMIRI-CHILLI', 5, 'g'],
      ['COCONUT-OIL', 15, 'ml'],
    ],
  ),
  dish(
    'BEBINCA',
    'Bebinca',
    'Food',
    'Desserts',
    '1 slice',
    KS,
    320,
    [3, 8],
    [
      ['EGGS', 2, 'each'],
      ['COCONUT-MILK', 80, 'ml'],
      ['FLOUR', 30, 'g'],
      ['SUGAR', 40, 'g'],
      ['BUTTER', 20, 'g'],
    ],
  ),
  // In-room dining
  dish(
    'IRD-CLUB-SANDWICH',
    'Club sandwich (in-room)',
    'Food',
    'In-room dining',
    '1 plate',
    KS,
    450,
    [2, 6],
    [
      ['SANDWICH-BREAD', 3, 'each'],
      ['CHICKEN', 80, 'g'],
      ['EGGS', 1, 'each'],
      ['CHEESE', 25, 'g'],
      ['TOMATOES', 40, 'g'],
      ['FRIES', 120, 'g'],
      ['OIL', 30, 'ml'],
    ],
  ),
  dish(
    'IRD-CHICKEN-XACUTI',
    'Chicken xacuti & rice (in-room)',
    'Food',
    'In-room dining',
    '1 plate',
    KS,
    620,
    [2, 6],
    [
      ['CHICKEN', 220, 'g'],
      ['XACUTI-MASALA', 120, 'g', P_],
      ['RED-RICE', 150, 'g'],
    ],
  ),
  dish(
    'IRD-MASALA-OMELETTE',
    'Masala omelette & toast (in-room)',
    'Food',
    'In-room dining',
    '1 plate',
    KS,
    300,
    [2, 5],
    [
      ['EGGS', 3, 'each'],
      ['ONIONS', 30, 'g'],
      ['GREEN-CHILLIES', 5, 'g'],
      ['SANDWICH-BREAD', 2, 'each'],
      ['BUTTER', 10, 'g'],
    ],
  ),
  // Pool snack bar (served by the bar team, cooked in the kitchen)
  dish(
    'POOL-FRIES',
    'Peri-peri fries (pool)',
    'Food',
    'Pool snacks',
    '1 basket',
    KS,
    280,
    [6, 14],
    [
      ['FRIES', 200, 'g'],
      ['OIL', 60, 'ml'],
      ['KASHMIRI-CHILLI', 3, 'g'],
      ['SALT', 3, 'g'],
    ],
  ),
  dish(
    'POOL-CHICKEN-POI',
    'Chicken cafreal poi (pool)',
    'Food',
    'Pool snacks',
    '2 pieces',
    KS,
    420,
    [3, 8],
    [
      ['POI', 2, 'each'],
      ['CHICKEN', 150, 'g'],
      ['CORIANDER', 15, 'g'],
      ['GREEN-CHILLIES', 8, 'g'],
      ['LIMES', 0.5, 'each'],
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
  DISHES.map((d, i) => [d.code, H, d.store, d.price, String(5001 + i)]),
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
        ['PRAWNS', 'KINGFISH', 'SQUID', 'PINEAPPLE', 'MUSKMELON'].includes(c) ? 10 : 0,
      ]),
    ),
  ],
);

// ---------------------------------------------------------------------------------------
// A past week: sales, batches, purchases, a stock check, attendance; and opening stock to
// carry it
// ---------------------------------------------------------------------------------------

const SALES: Cell[][] = [];
const used = new Map<string, number>(); // `item store` -> stock units used over the week
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
    SALES.push([H, d, x.code, n, U('gm')]);
    for (const [c, qty, unit, kind] of x.lines) {
      // a prep comes from its batches (below), not from the raw items
      if (kind !== 'prep') useOf(c, x.store, n * qty, unit);
    }
  }
}
csv(
  '27_sales_TEST_DATA_ONLY.csv',
  ['outlet_code', 'day', 'menu_item_code', 'quantity', 'posted_by'],
  SALES,
);

// batches of the preps every other day, as the people who make them
const PRODUCTION: Cell[][] = [];
for (const p of PREPS) {
  for (const s of p.at) {
    for (const d of [-7, -5, -3, -1]) {
      PRODUCTION.push([
        s,
        p.code,
        d,
        s === KS ? '09:30' : '16:00',
        p.yield,
        s === KS ? U('cdp') : s === LOBBY ? U('head-bartender') : U('bartender'),
      ]);
    }
  }
}
// what the batches take from the stores
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
    const u = used.get(`${l.item} ${l.store}`) ?? 0;
    const each =
      ['each', 'bottle', 'can', 'pack'].includes(ITEM.get(l.item)!.unit) && !ITEM.get(l.item)!.conv;
    const qty = l.par * 0.7 + u * 1.05;
    return [
      l.item,
      l.store,
      each || ITEM.get(l.item)!.unit === 'bottle' ? Math.ceil(qty) : Math.round(qty * 10) / 10,
      ITEM.get(l.item)!.cost,
      day(-8),
    ];
  }),
);

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
    ['PO-1', KS, 'SUP-SEAFOOD', 'PRAWNS', 8, 640, -6, U('chef'), U('gm'), -5, 8, U('sous-chef')],
    [
      'PO-1',
      KS,
      'SUP-SEAFOOD',
      'KINGFISH',
      6,
      900,
      -6,
      U('chef'),
      U('gm'),
      -5,
      5.4,
      U('sous-chef'),
    ],
    ['PO-1', KS, 'SUP-SEAFOOD', 'SQUID', 4, 420, -6, U('chef'), U('gm'), -5, 4, U('sous-chef')],
    ['PO-2', KS, 'SUP-PRODUCE', 'ONIONS', 20, 34, -4, U('chef'), U('gm'), -3, 20, U('cdp')],
    ['PO-2', KS, 'SUP-PRODUCE', 'TOMATOES', 15, 42, -4, U('chef'), U('gm'), -3, 15, U('cdp')],
    ['PO-2', KS, 'SUP-PRODUCE', 'LIMES', 100, 4, -4, U('chef'), U('gm'), -3, 100, U('cdp')],
    [
      'PO-3',
      MAIN,
      'SUP-SPIRITS',
      'FENI-750ML',
      24,
      650,
      -5,
      U('store-keeper'),
      U('gm'),
      -3,
      24,
      U('receiving'),
    ],
    [
      'PO-3',
      MAIN,
      'SUP-SPIRITS',
      'TEQUILA-750ML',
      12,
      3200,
      -5,
      U('store-keeper'),
      U('gm'),
      -3,
      10,
      U('receiving'),
    ],
    [
      'PO-3',
      MAIN,
      'SUP-SPIRITS',
      'LAGER-330ML',
      240,
      88,
      -5,
      U('store-keeper'),
      U('gm'),
      -3,
      240,
      U('receiving'),
    ],
    [
      'PO-4',
      HK,
      'SUP-HOTEL',
      'SHAMPOO-30ML',
      300,
      18,
      -3,
      U('executive-housekeeper'),
      U('gm'),
      -1,
      300,
      U('housekeeping-supervisor'),
    ],
    [
      'PO-4',
      HK,
      'SUP-HOTEL',
      'POOL-CHLORINE',
      20,
      180,
      -3,
      U('executive-housekeeper'),
      U('gm'),
      -1,
      20,
      U('housekeeping-supervisor'),
    ],
    // ordered yesterday, arriving today: the store keeper receives it in the pitch
    [
      'PO-5',
      MAIN,
      'SUP-GROCERY',
      'CASHEWS-100G',
      40,
      140,
      -1,
      U('store-keeper'),
      U('gm'),
      '',
      '',
      '',
    ],
    ['PO-5', MAIN, 'SUP-GROCERY', 'WATER-1L', 240, 20, -1, U('store-keeper'), U('gm'), '', '', ''],
  ],
);

// the Layover bar's closing count yesterday
csv(
  '28_counts_TEST_DATA_ONLY.csv',
  ['store_node_code', 'item_code', 'difference', 'counted_by', 'approved_by'],
  [
    [LAYOVER, 'FENI-750ML', -0.3, U('head-bartender'), U('gm')],
    [LAYOVER, 'GIN-750ML', -0.1, U('head-bartender'), U('gm')],
    [LAYOVER, 'LAGER-330ML', -2, U('head-bartender'), U('gm')],
    [LAYOVER, 'TONIC-200ML', 0, U('head-bartender'), U('gm')],
  ],
);

// no file 36: a stock request from the Main Store is shown live in the pitch

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
  PEOPLE.filter((p) => p.user !== U('presenter')).flatMap((p) => [
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

// who works shifts, when: [user, department, shift, start, end, days off]
const SHIFTS: [string, string, string, string, string][] = [
  ['front-desk', 'FRONT-OFFICE', 'Morning', '07:00', '15:00'],
  ['bell-captain', 'FRONT-OFFICE', 'Morning', '07:00', '15:00'],
  ['housekeeping-supervisor', 'HOUSEKEEPING', 'Day', '08:00', '16:00'],
  ['room-attendant', 'HOUSEKEEPING', 'Day', '08:00', '16:00'],
  ['public-area', 'HOUSEKEEPING', 'Day', '08:00', '16:00'],
  ['laundry', 'HOUSEKEEPING', 'Day', '08:00', '16:00'],
  ['pool', 'HOUSEKEEPING', 'Pool', '07:00', '15:00'],
  ['sous-chef', 'KITCHEN', 'Day', '07:00', '15:00'],
  ['cdp', 'KITCHEN', 'Day', '07:00', '15:00'],
  ['commis', 'KITCHEN', 'Evening', '14:00', '22:00'],
  ['steward', 'KITCHEN', 'Evening', '14:00', '22:00'],
  ['captain', 'RESTAURANT', 'Breakfast', '06:30', '14:30'],
  ['server', 'RESTAURANT', 'Breakfast', '06:30', '14:30'],
  ['host', 'RESTAURANT', 'Breakfast', '06:30', '14:30'],
  ['head-bartender', 'BAR', 'Evening', '16:00', '00:00'],
  ['bartender', 'BAR', 'Evening', '16:00', '00:00'],
  ['bar-back', 'BAR', 'Evening', '16:00', '00:00'],
  ['ird', 'IN-ROOM-DINING', 'Evening', '15:00', '23:00'],
  ['cashier', 'CASHIER', 'Evening', '15:00', '23:00'],
  ['technician', 'ENGINEERING', 'Day', '09:00', '17:00'],
  ['receiving', 'STORES-TEAM', 'Day', '08:00', '16:00'],
  ['banquet-captain', 'BANQUETS', 'Event', '15:00', '23:00'],
  ['banquet-server', 'BANQUETS', 'Event', '15:00', '23:00'],
];
const roleOf = (user: string) => PEOPLE.find((p) => p.user === U(user))!.role;
const headOf: Record<string, string> = {
  'FRONT-OFFICE': 'front-office-manager',
  HOUSEKEEPING: 'executive-housekeeper',
  KITCHEN: 'chef',
  RESTAURANT: 'restaurant-manager',
  BAR: 'bar-manager',
  'IN-ROOM-DINING': 'restaurant-manager',
  CASHIER: 'gm',
  ENGINEERING: 'chief-engineer',
  'STORES-TEAM': 'purchase-manager',
  BANQUETS: 'banquet-manager',
};
const templates = new Map<string, Cell[]>();
for (const [user, dept, shift, start, end] of SHIFTS) {
  const k = `${dept} ${shift} ${roleOf(user)}`;
  const t = templates.get(k);
  if (t) t[5] = (t[5] as number) + 1;
  else templates.set(k, [D(dept), shift, start, end, roleOf(user), 1, 'Mon-Sun']);
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
  ],
  [...templates.values()],
);
const OFF = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
csv(
  '25_shifts_TEST_DATA_ONLY.csv',
  ['roster_node_code', 'shift_name', 'job_role_code', 'week', 'days', 'username', 'rostered_by'],
  SHIFTS.map(([user, dept, shift], i) => {
    const off = i % 7;
    const days = OFF.filter((_, j) => j !== off);
    // six days, as runs of consecutive days
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
    void days;
    return [D(dept), shift, roleOf(user), 1, runs.join(','), U(user), U(headOf[dept]!)];
  }),
);
// the past week's clock-ins, a few late, one missing
const ATTENDANCE: Cell[][] = [];
for (const [i, [user, , , start, end]] of SHIFTS.entries()) {
  for (let d = -7; d <= -1; d++) {
    if ((d + 7 + i) % 7 === 0) continue; // a day off
    if (user === 'bar-back' && d === -2) continue; // no-show
    const late = (i + d) % 9 === 0 ? 14 : pick(0, 6);
    const [h, m] = start.split(':').map(Number) as [number, number];
    const inAt = `${String(h + Math.floor((m + late) / 60)).padStart(2, '0')}:${String((m + late) % 60).padStart(2, '0')}`;
    // night shifts end at midnight: clock out at 23:55 the same day
    const out = end === '00:00' ? '23:55' : end;
    ATTENDANCE.push([U(user), d, inAt, out]);
  }
}
csv('35_attendance_TEST_DATA_ONLY.csv', ['username', 'day', 'clock_in', 'clock_out'], ATTENDANCE);
csv(
  '34_pay_rates.csv',
  ['username', 'pay_basis', 'pay_rate_inr'],
  PEOPLE.filter((p) => p.user !== U('presenter')).map((p) => [p.user, 'monthly', p.pay]),
);

// ---------------------------------------------------------------------------------------
// Checklists, tasks and maintenance
// ---------------------------------------------------------------------------------------

type Step = [
  label: string,
  kind: 'tick' | 'number' | 'text' | 'photo',
  min?: number,
  max?: number,
  unit?: string,
];
const LISTS: [
  code: string,
  place: string,
  name: string,
  schedule: string,
  assign: string,
  steps: Step[],
][] = [
  [
    'KITCHEN-OPENING',
    D('KITCHEN'),
    'Kitchen opening',
    'daily 07:00',
    'role:COMMIS',
    [
      ['Walk-in chiller temperature', 'number', 0, 5, '°C'],
      ['Freezer temperature', 'number', -22, -18, '°C'],
      ['Seafood delivery on ice and smelling fresh', 'tick'],
      ['Hand-wash station stocked', 'tick'],
    ],
  ],
  [
    'LAYOVER-SETUP',
    D('BAR'),
    'Layover bar set-up',
    'daily 16:30',
    'role:BARTENDER',
    [
      ['Ice well filled', 'tick'],
      ['Limes, pineapple and chillies cut', 'tick'],
      ['House preps in date (tepache, shrub, syrups)', 'tick'],
      ['Back bar photo', 'photo'],
    ],
  ],
  [
    'MINI-BAR-SETUP',
    D('BAR'),
    'Mini Bar (lobby) set-up',
    'daily 17:00',
    'role:HEAD_BARTENDER',
    [
      ['Signature preps labelled and in date', 'tick'],
      ['Thecha salt rims ready', 'tick'],
      ['Glassware polished', 'tick'],
    ],
  ],
  [
    'POOL-WATER',
    D('HOUSEKEEPING'),
    'Pool water test',
    'daily 08:00 12:00 16:00',
    'role:POOL_ATTENDANT',
    [
      ['pH', 'number', 7.2, 7.8, 'pH'],
      ['Free chlorine', 'number', 1, 3, 'ppm'],
      ['Water clear, no incident', 'tick'],
    ],
  ],
  [
    'POOL-SAFETY',
    D('HOUSEKEEPING'),
    'Pool safety check',
    'daily 07:00',
    'role:POOL_ATTENDANT',
    [
      ['No glassware on the pool deck', 'tick'],
      ['Depth markings and signs in place', 'tick'],
      ['Pool towels stocked', 'tick'],
    ],
  ],
  [
    'ROOM-INSPECTION',
    D('HOUSEKEEPING'),
    'Room inspection round',
    'daily 11:00',
    'role:HOUSEKEEPING_SUPERVISOR',
    [
      ['Vacated rooms inspected', 'tick'],
      ['Minibars checked in vacated rooms', 'tick'],
      ['Rooms ready by 14:00', 'tick'],
    ],
  ],
  [
    'FRONT-OFFICE-HANDOVER',
    D('FRONT-OFFICE'),
    'Front office handover',
    'daily 15:00',
    'role:FRONT_DESK_EXECUTIVE',
    [
      ['Arrivals and VIPs noted', 'tick'],
      ['Minibar charges added to bills', 'tick'],
      ['Cash float counted', 'number', 0, 20000, '₹'],
    ],
  ],
  [
    'JET-LAG-SETUP',
    D('BANQUETS'),
    'Jet Lag event set-up',
    'daily 16:00',
    'role:BANQUET_CAPTAIN',
    [
      ['Room set to the event sheet', 'tick'],
      ['Sound and lights tested', 'tick'],
      ['Set-up photo', 'photo'],
    ],
  ],
];
csv(
  '29_checklist_templates.csv',
  [
    'template_code',
    'place_code',
    'name',
    'schedule',
    'assign_to',
    'step',
    'step_label',
    'step_kind',
    'min',
    'max',
    'unit',
    'photo_required',
    'from_library',
  ],
  LISTS.flatMap(([code, place, name, schedule, assign, steps]) =>
    steps.map(([label, kind, min, max, unit], i) => [
      code,
      place,
      name,
      schedule,
      assign,
      i + 1,
      label,
      kind,
      min ?? '',
      max ?? '',
      unit ?? '',
      'no',
      '',
    ]),
  ),
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
      D('BAR'),
      'Batch tepache for the weekend',
      'Three days to ferment: start it today',
      0,
      '18:00',
      'high',
      `person:${U('bartender')}`,
      'Pineapple prepped;Jars labelled',
      U('bar-manager'),
      '',
    ],
    [
      D('HOUSEKEEPING'),
      'Restock minibars on the second floor',
      '',
      0,
      '13:00',
      'normal',
      `person:${U('room-attendant')}`,
      '',
      U('executive-housekeeper'),
      '',
    ],
    [
      D('KITCHEN'),
      'Deep clean the tandoor area',
      '',
      -1,
      '16:00',
      'normal',
      `person:${U('commis')}`,
      'Scrubbed;Floor mopped',
      U('sous-chef'),
      U('commis'),
    ],
    [
      D('BANQUETS'),
      'Set Jet Lag for the sangeet walk-through',
      '',
      1,
      '12:00',
      'high',
      `person:${U('banquet-captain')}`,
      'Floor plan printed;Stage measured',
      U('banquet-manager'),
      '',
    ],
  ],
);
csv(
  '31_maintenance_TEST_DATA_ONLY.csv',
  ['place_code', 'title', 'description', 'reported_by', 'assigned_to', 'assigned_by'],
  [
    [
      D('FRONT-OFFICE'),
      'Room 204: AC not cooling',
      'Guest complained at 23:00; moved to 206 for the night',
      U('front-desk'),
      U('technician'),
      U('chief-engineer'),
    ],
    [
      D('HOUSEKEEPING'),
      'Pool pump making a grinding noise',
      'Started this morning',
      U('pool'),
      '',
      '',
    ],
  ],
);

// ---------------------------------------------------------------------------------------
// Events at Jet Lag, licences and the compliance calendar
// ---------------------------------------------------------------------------------------

csv(
  '17_events_TEST_DATA_ONLY.csv',
  ['org_node_code', 'event_name', 'starts_at', 'ends_at', 'covers', 'requirements'],
  [
    [
      H,
      'Feni & gin tasting at Jet Lag',
      `${day(3)} 18:00`,
      `${day(3)} 21:00`,
      30,
      'item FENI-750ML = 4 bottle; item GIN-750ML = 3 bottle; item TONIC-200ML = 48 can; role BARTENDER = 2 (17:30-21:30); role BANQUET_SERVER = 2 (17:30-21:30)',
    ],
    [
      H,
      'Sangeet at Jet Lag (private)',
      `${day(9)} 19:00`,
      `${day(9)} 23:30`,
      80,
      'item PRAWNS = 6 kg; item CHICKEN = 10 kg; item LAGER-330ML = 120 bottle; role BANQUET_SERVER = 6 (18:00-00:00); role BARTENDER = 2 (18:30-00:00)',
    ],
  ],
);
csv(
  '38_licences.csv',
  ['place_code', 'kind', 'name', 'number', 'authority', 'issued_on', 'expires_on', 'renewal_role'],
  [
    [
      H,
      'FSSAI',
      'FSSAI licence',
      '10024999000456',
      'FSSAI',
      day(-500),
      day(230),
      'GENERAL_MANAGER',
    ],
    [
      H,
      'EXCISE_BAR',
      'Bar licence (excise)',
      'EXC/BAR/2025/0789',
      'Goa Excise Department',
      day(-340),
      day(25),
      'ACCOUNTANT',
    ],
    [
      H,
      'FIRE_NOC',
      'Fire NOC',
      'GFS/NOC/2024/1123',
      'Goa Fire & Emergency Services',
      day(-600),
      day(495),
      'CHIEF_ENGINEER',
    ],
    [
      H,
      'TRADE_HEALTH',
      'Trade licence',
      'ASG/TL/2025/044',
      'Assagao Village Panchayat',
      day(-280),
      day(85),
      'ACCOUNTANT',
    ],
    [
      H,
      'SWIMMING_POOL',
      'Swimming pool licence',
      'POOL/2025/031',
      'Directorate of Health Services',
      day(-200),
      day(165),
      'CHIEF_ENGINEER',
    ],
    [
      H,
      'MUSIC',
      'Music licence',
      'PPL/2025/55871',
      'Music licensing society',
      day(-120),
      day(245),
      'GENERAL_MANAGER',
    ],
  ],
);
csv(
  '39_compliance_calendar.csv',
  ['place_code', 'name', 'every_months', 'next_due', 'owner_role', 'needs_proof', 'from_library'],
  [
    [H, 'Pest control service', 1, day(-2), 'GENERAL_MANAGER', 'yes', 'PEST-CONTROL@1'],
    [H, 'Fire extinguisher check', 6, day(40), 'CHIEF_ENGINEER', 'yes', 'EXTINGUISHER-CHECK@1'],
    [
      D('KITCHEN'),
      'Kitchen exhaust duct cleaning',
      6,
      day(12),
      'EXECUTIVE_CHEF',
      'yes',
      'DUCT-CLEANING@1',
    ],
    [H, 'Water test', 6, day(60), 'CHIEF_ENGINEER', 'yes', 'WATER-TEST@1'],
    [H, 'FSSAI annual return', 12, day(150), 'ACCOUNTANT', 'yes', 'FSSAI-ANNUAL-RETURN@1'],
  ],
);

// ---------------------------------------------------------------------------------------
// Rooms and minibars
// ---------------------------------------------------------------------------------------

const ROOMS: [number, number, string][] = [];
for (const [floor, numbers] of [
  [1, [101, 102, 103, 104, 105, 106, 107, 108, 109]],
  [2, [201, 202, 203, 204, 205, 206, 207, 208, 209]],
  [3, [301, 302, 303, 304, 305, 306]],
] as const) {
  for (const n of numbers)
    ROOMS.push([n, floor, n % 100 >= 8 ? 'Explorer Suite' : 'Passport Deluxe']);
}
ROOMS.push([10, 0, 'Pool Terrace'], [11, 0, 'Pool Terrace'], [12, 0, 'Pool Terrace']);
csv(
  '40_rooms.csv',
  ['outlet_code', 'room_number', 'floor', 'room_type', 'minibar_set'],
  ROOMS.map(([n, floor, type]) => [
    H,
    floor === 0 ? `P-${String(n).padStart(2, '0')}` : String(n),
    floor === 0 ? 'Pool level' : String(floor),
    type,
    type === 'Passport Deluxe' ? 'Standard' : 'Suite',
  ]),
);
const SETS: [string, string, number, number][] = [
  ['Standard', 'WATER-1L', 2, 0],
  ['Standard', 'COLA-300ML', 2, 120],
  ['Standard', 'LAGER-330ML', 2, 250],
  ['Standard', 'CASHEWS-100G', 1, 350],
  ['Standard', 'CHIPS-PACK', 1, 150],
  ['Standard', 'CHOCOLATE-BAR', 1, 200],
  ['Suite', 'WATER-1L', 2, 0],
  ['Suite', 'COLA-300ML', 2, 120],
  ['Suite', 'LAGER-330ML', 4, 250],
  ['Suite', 'CASHEWS-100G', 2, 350],
  ['Suite', 'CHIPS-PACK', 1, 150],
  ['Suite', 'CHOCOLATE-BAR', 2, 200],
  ['Suite', 'FENI-NIP-180ML', 1, 450],
];
csv(
  '41_minibar_sets.csv',
  ['outlet_code', 'set_name', 'store_node_code', 'item_code', 'par', 'price_inr'],
  SETS.map(([set, item, par, price]) => [H, set, HK, item, par, price]),
);
// checks over the past week; the last few still to add to the bill
const CHECKS: Cell[][] = [];
const roomName = (n: number, floor: number) =>
  floor === 0 ? `P-${String(n).padStart(2, '0')}` : String(n);
let checkNo = 0;
for (let d = -6; d <= 0; d++) {
  for (const [n, floor, type] of ROOMS) {
    if (rand() > 0.3) continue; // a checkout that day
    checkNo++;
    const set = type === 'Passport Deluxe' ? 'Standard' : 'Suite';
    const time = d === 0 ? '10:30' : `${String(pick(10, 12))}:${pick(0, 1) ? '15' : '45'}`;
    const charged = d < -1 || (d === -1 && checkNo % 2 === 0);
    for (const [s, item, par] of SETS) {
      if (s !== set) continue;
      const left = rand() < 0.35 ? Math.max(par - pick(1, par), 0) : par;
      CHECKS.push([
        H,
        roomName(n, floor),
        d,
        time,
        item,
        left,
        U('room-attendant'),
        charged ? U('front-desk') : '',
      ]);
    }
  }
}
csv(
  '42_minibar_checks_TEST_DATA_ONLY.csv',
  ['outlet_code', 'room_number', 'day', 'time', 'item_code', 'left', 'checked_by', 'charged_by'],
  CHECKS,
);

// the cashier's end-of-day file from the POS, for the pitch: yesterday's food at Layover
const posLines = DISHES.filter((d) => d.menu === 'Food').slice(0, 10);
const pos = posLines.map((d, i) => [
  String(5001 + DISHES.indexOf(d)),
  d.name.toUpperCase(),
  2 + (i % 4),
  d.price,
]);
const total = pos.reduce((s, [, , n, p]) => s + (n as number) * (p as number), 0);
files['pos-sale-by-item.csv'] =
  [
    'Sale by item,,,,,',
    'Item,Description,Quantity,Rate,Value,Discount',
    'LAYOVER,,,,,',
    ...pos.map(([c, name, n, p]) => [c, q(name), n, p, (n as number) * (p as number), 0].join(',')),
    `Grand Total,,${pos.reduce((s, [, , n]) => s + (n as number), 0)},,${total},0`,
  ].join('\n') + '\n';

// ---------------------------------------------------------------------------------------

// every kept item a recipe uses: catch a slip here, not in the console
for (const d of DISHES) {
  for (const [c, , , k] of d.lines) {
    if (k === 'prep') {
      if (!PREP.get(c)!.at.includes(d.store))
        throw new Error(`${d.code}: ${c} is not made at ${d.store}`);
    } else if (!KEPT.has(`${c} ${d.store}`))
      throw new Error(`${d.code}: ${c} is not kept at ${d.store}`);
  }
}
for (const p of PREPS) {
  for (const s of p.at) {
    for (const [c, , , k] of p.lines) {
      if (k !== 'prep' && !KEPT.has(`${c} ${s}`))
        throw new Error(`${p.code}: ${c} is not kept at ${s}`);
    }
  }
}

mkdirSync(OUT, { recursive: true });
for (const [name, text] of Object.entries(files)) writeFileSync(join(OUT, name), text);
console.log(`wrote ${Object.keys(files).length} files to ${OUT} (dates from ${TODAY})`);
