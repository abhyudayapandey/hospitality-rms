// The role and department catalogue (ADR 058, 060): every role and department the six SOP
// manuals in docs/sop name, with the duties (ADR 059) a role holds by default. A customer
// lists a catalogue role in file 06 by its code alone and gets its title, department and
// duties; a row that is filled in is used as written. Step 2 of docs/templates-and-cover.md.
//
// A role only holds duties for work the app does today: a Night Auditor or a Therapist is
// rostered, clocks in and gets checklists and tasks ("works shifts"), not a night audit.
// Two names are one role only where an SOP lists them as one job ("Steward / Server").
// A hotel's head of Stores is the Purchase Manager ("Store Manager" is another name for it,
// ADR 066), so the QSR's Store Manager is QSR_STORE_MANAGER, titled "Store Manager".

import type { OutletFormat } from './formats';
import { DUTY_BY_CODE, expandDuty } from './duties';

/** The SOP manuals: Restaurant, Bar and brewery, Cloud kitchen, Franchise, Hotel, QSR. */
export type Sop = 'R' | 'B' | 'C' | 'F' | 'H' | 'Q';

/** What a department does, for the order of Home's "Needs attention" (ADR 033). */
export type DepartmentType = 'kitchen' | 'service' | 'housekeeping' | 'other';

export interface DepartmentDef {
  /** The suffix of a department's place code: `<OUTLET>-KITCHEN`. */
  code: string;
  name: string;
  type: DepartmentType;
  /** The store a department of this kind usually keeps, if any. */
  store?: string;
  sops: readonly Sop[];
}

export const DEPARTMENTS: readonly DepartmentDef[] = [
  {
    code: 'KITCHEN',
    name: 'Kitchen',
    type: 'kitchen',
    store: 'Kitchen Store',
    sops: ['R', 'B', 'C', 'H', 'Q'],
  },
  { code: 'BAR', name: 'Bar', type: 'service', store: 'Bar Store', sops: ['R', 'B', 'H'] },
  { code: 'RESTAURANT', name: 'Restaurant', type: 'service', sops: ['R', 'H'] },
  { code: 'FLOOR-SERVICE', name: 'Floor Service', type: 'service', sops: ['B'] },
  { code: 'COUNTER', name: 'Counter', type: 'service', sops: ['Q', 'R'] },
  { code: 'IN-ROOM-DINING', name: 'In-Room Dining', type: 'service', sops: ['H'] },
  { code: 'BANQUETS', name: 'Banquets', type: 'service', sops: ['H'] },
  { code: 'FRONT-OFFICE', name: 'Front Office', type: 'other', sops: ['H'] },
  {
    code: 'HOUSEKEEPING',
    name: 'Housekeeping',
    type: 'housekeeping',
    store: 'Housekeeping Store',
    sops: ['H'],
  },
  {
    code: 'STORES-TEAM',
    name: 'Stores',
    type: 'other',
    store: 'Main Store',
    sops: ['R', 'B', 'C', 'H', 'Q'],
  },
  { code: 'ENGINEERING', name: 'Engineering', type: 'other', sops: ['H'] },
  { code: 'SECURITY', name: 'Security', type: 'other', sops: ['H', 'B'] },
  {
    code: 'ADMIN-FINANCE',
    name: 'Admin & Finance',
    type: 'other',
    sops: ['R', 'B', 'C', 'H', 'Q'],
  },
  { code: 'HR', name: 'Human Resources', type: 'other', sops: ['H'] },
  { code: 'IT', name: 'IT', type: 'other', sops: ['H'] },
  { code: 'SALES-MARKETING', name: 'Sales & Marketing', type: 'other', sops: ['H', 'C'] },
  {
    code: 'SPA-RECREATION',
    name: 'Spa & Recreation',
    type: 'other',
    store: 'Spa Store',
    sops: ['H'],
  },
  { code: 'BREWHOUSE', name: 'Brewhouse', type: 'kitchen', store: 'Brewhouse Store', sops: ['B'] },
  { code: 'DISPATCH', name: 'Packing & Dispatch', type: 'other', sops: ['C'] },
  { code: 'EVENTS', name: 'Events & Entertainment', type: 'other', sops: ['B'] },
  { code: 'CENTRAL-KITCHEN-PRODUCTION', name: 'Production', type: 'kitchen', sops: ['Q', 'C'] },
  { code: 'CENTRAL-KITCHEN-DISPATCH-TEAM', name: 'Dispatch Team', type: 'other', sops: ['Q', 'C'] },
];

/** Where a role's people usually work: a department, or a level with no department. */
export type RoleHome = string; // a DEPARTMENTS code, or '(company)', '(area)', '(outlet)'
export const ROLE_HOMES_WITHOUT_DEPARTMENT = ['(company)', '(area)', '(outlet)'] as const;

export interface RoleDef {
  code: string;
  title: string;
  /** Other names the SOPs use for the same job. */
  alsoCalled?: readonly string[];
  home: RoleHome;
  /** Duties, as in file 06: `RUNS_DEPARTMENT; RUNS_DEPARTMENT@department:BAR`. */
  duties: readonly string[];
  /** Different duties in an outlet of this format (a Bar Manager runs a standalone bar). */
  formatDuties?: Readonly<Partial<Record<OutletFormat, readonly string[]>>>;
  /** Where they work in an outlet of that format (a standalone bar's Bar Manager: the outlet). */
  formatHome?: Readonly<Partial<Record<OutletFormat, RoleHome>>>;
  /** The SOP manuals that name it; none for a role of the app's own (HR Admin). */
  sops: readonly Sop[];
}

const W = 'WORKS_SHIFTS';
const L = 'LEADS_SHIFT';
const D = 'RUNS_DEPARTMENT';

export const ROLES: readonly RoleDef[] = [
  // company and area
  {
    code: 'ACCOUNT_OWNER',
    title: 'Account Owner',
    alsoCalled: ['Owner', 'Partner', 'Licensee', 'Founder'],
    home: '(company)',
    duties: ['OWNS_COMPANY_ACCOUNT'],
    sops: ['R', 'B', 'C', 'F', 'H', 'Q'],
  },
  {
    code: 'AREA_MANAGER',
    title: 'Area Manager',
    alsoCalled: ['Field Consultant'],
    home: '(area)',
    duties: ['RUNS_AREA'],
    sops: ['Q', 'F'],
  },
  { code: 'HR_ADMIN', title: 'HR Admin', home: '(company)', duties: ['RUNS_COMPANY_HR'], sops: [] },
  {
    code: 'SECURITY_ADMIN',
    title: 'Security Admin',
    home: '(company)',
    duties: ['APPROVES_ACCESS'],
    sops: [],
  },
  {
    code: 'AUDITOR',
    title: 'Auditor',
    home: '(company)',
    duties: ['AUDITS_COMPANY'],
    sops: ['F', 'Q'],
  },

  // the outlet
  {
    code: 'GENERAL_MANAGER',
    title: 'General Manager',
    alsoCalled: ['Outlet Manager'],
    home: '(outlet)',
    duties: ['RUNS_OUTLET'],
    sops: ['B', 'H'],
  },
  {
    code: 'ASSISTANT_GENERAL_MANAGER',
    title: 'Assistant General Manager',
    home: '(outlet)',
    duties: ['RUNS_OUTLET'],
    sops: ['H'],
  },
  {
    code: 'RESTAURANT_GENERAL_MANAGER',
    title: 'Restaurant Manager',
    home: '(outlet)',
    duties: ['RUNS_OUTLET'],
    sops: ['R'],
  },
  {
    code: 'ASSISTANT_MANAGER',
    title: 'Assistant Manager',
    alsoCalled: ['Shift Manager'],
    home: '(outlet)',
    duties: [L, W],
    sops: ['R'],
  },
  {
    code: 'QSR_STORE_MANAGER',
    title: 'Store Manager',
    alsoCalled: ['Restaurant General Manager'],
    home: '(outlet)',
    duties: ['RUNS_OUTLET'],
    sops: ['Q', 'F'],
  },
  {
    code: 'ASSISTANT_STORE_MANAGER',
    title: 'Assistant Store Manager',
    home: '(outlet)',
    duties: ['RUNS_OUTLET'],
    sops: ['Q'],
  },
  {
    code: 'KITCHEN_MANAGER',
    title: 'Kitchen Manager',
    home: '(outlet)',
    duties: ['RUNS_OUTLET'],
    sops: ['C'],
  },
  {
    code: 'DUTY_MANAGER',
    title: 'Duty Manager',
    alsoCalled: ['Manager on Duty'],
    home: '(outlet)',
    duties: [L, W],
    sops: ['H'],
  },

  // kitchen
  {
    code: 'EXECUTIVE_CHEF',
    title: 'Executive Chef',
    home: 'KITCHEN',
    duties: [D, 'KEEPS_DEPARTMENT_STORE', 'WRITES_SHIFT_BRIEFING'],
    sops: ['H'],
  },
  {
    code: 'HEAD_COOK',
    title: 'Head Cook',
    alsoCalled: ['Head Chef'],
    home: 'KITCHEN',
    duties: [D, 'KEEPS_DEPARTMENT_STORE', 'WRITES_SHIFT_BRIEFING'],
    sops: ['R', 'B'],
  },
  {
    code: 'EXECUTIVE_SOUS_CHEF',
    title: 'Executive Sous Chef',
    home: 'KITCHEN',
    duties: [L, 'USES_DEPARTMENT_STORE', W],
    sops: ['H'],
  },
  {
    code: 'SOUS_CHEF',
    title: 'Sous Chef',
    alsoCalled: ['Shift Lead'],
    home: 'KITCHEN',
    duties: [L, 'USES_DEPARTMENT_STORE', W],
    sops: ['R', 'C', 'H'],
  },
  {
    code: 'CHEF_DE_PARTIE',
    title: 'Chef de Partie',
    home: 'KITCHEN',
    duties: ['USES_DEPARTMENT_STORE', W],
    sops: ['R', 'H'],
  },
  {
    code: 'COOK',
    title: 'Cook',
    alsoCalled: ['Line Cook'],
    home: 'KITCHEN',
    duties: ['USES_DEPARTMENT_STORE', W, 'MAKES_PREP'],
    sops: ['R', 'C'],
  },
  {
    code: 'COMMIS',
    title: 'Commis',
    alsoCalled: ['Kitchen Helper'],
    home: 'KITCHEN',
    duties: [W, 'MAKES_PREP'],
    sops: ['R', 'H'],
  },
  {
    code: 'PASTRY_CHEF',
    title: 'Pastry Chef',
    home: 'KITCHEN',
    duties: ['USES_DEPARTMENT_STORE', W, 'MAKES_PREP'],
    sops: ['H'],
  },
  {
    code: 'BAKER',
    title: 'Baker',
    home: 'KITCHEN',
    duties: ['USES_DEPARTMENT_STORE', W, 'MAKES_PREP'],
    sops: ['H'],
  },
  {
    code: 'KITCHEN_STEWARD',
    title: 'Kitchen Steward',
    alsoCalled: ['Utility', 'Dishwasher'],
    home: 'KITCHEN',
    duties: [W],
    sops: ['R', 'H'],
  },
  { code: 'CHIEF_STEWARD', title: 'Chief Steward', home: 'KITCHEN', duties: [L, W], sops: ['H'] },
  {
    code: 'FOOD_SAFETY_SUPERVISOR',
    title: 'Food Safety Supervisor',
    home: 'KITCHEN',
    duties: [L, W],
    sops: ['R', 'C', 'H', 'Q'],
  },

  // bar
  {
    code: 'BAR_MANAGER',
    title: 'Bar Manager',
    home: 'BAR',
    duties: [D, 'KEEPS_DEPARTMENT_STORE', 'WRITES_SHIFT_BRIEFING'],
    formatDuties: { bar_pub: ['RUNS_OUTLET'] },
    formatHome: { bar_pub: '(outlet)' },
    sops: ['B', 'H'],
  },
  {
    code: 'HEAD_BARTENDER',
    title: 'Head Bartender',
    home: 'BAR',
    duties: [L, 'USES_DEPARTMENT_STORE', W],
    sops: ['B'],
  },
  {
    code: 'BARTENDER',
    title: 'Bartender',
    home: 'BAR',
    duties: [W, 'MAKES_PREP'],
    sops: ['R', 'B', 'H'],
  },
  { code: 'BAR_BACK', title: 'Bar Back', home: 'BAR', duties: [W], sops: ['B'] },
  { code: 'BARISTA', title: 'Barista', home: 'BAR', duties: [W, 'MAKES_PREP'], sops: ['R'] },
  { code: 'SOMMELIER', title: 'Sommelier', home: 'RESTAURANT', duties: [W], sops: ['R'] },

  // brewhouse
  {
    code: 'HEAD_BREWER',
    title: 'Head Brewer',
    home: 'BREWHOUSE',
    duties: [D, 'KEEPS_DEPARTMENT_STORE'],
    sops: ['B'],
  },
  {
    code: 'BREWER',
    title: 'Brewer',
    home: 'BREWHOUSE',
    duties: ['USES_DEPARTMENT_STORE', W, 'MAKES_PREP'],
    sops: ['B'],
  },

  // restaurant and floor service
  {
    code: 'FANDB_MANAGER',
    title: 'F&B Manager',
    alsoCalled: ['Director of F&B'],
    home: 'RESTAURANT',
    duties: [
      D,
      `${D}@department:BAR`,
      `${D}@department:BANQUETS`,
      'PLANS_EVENTS',
      'WRITES_SHIFT_BRIEFING',
    ],
    sops: ['H'],
  },
  {
    code: 'RESTAURANT_MANAGER',
    title: 'Restaurant Manager',
    alsoCalled: ['Outlet Manager'],
    home: 'RESTAURANT',
    duties: [D, 'PLANS_EVENTS', 'WRITES_SHIFT_BRIEFING'],
    sops: ['H'],
  },
  {
    code: 'ASSISTANT_RESTAURANT_MANAGER',
    title: 'Assistant Restaurant Manager',
    home: 'RESTAURANT',
    duties: [L, W],
    sops: ['H'],
  },
  {
    code: 'CAPTAIN',
    title: 'Captain',
    alsoCalled: ['Supervisor'],
    home: 'RESTAURANT',
    duties: [L, W],
    sops: ['R', 'H'],
  },
  {
    code: 'STEWARD',
    title: 'Steward',
    alsoCalled: ['Server', 'Waiter'],
    home: 'RESTAURANT',
    duties: [W],
    sops: ['R', 'H'],
  },
  {
    code: 'HOST',
    title: 'Host',
    alsoCalled: ['Hostess'],
    home: 'RESTAURANT',
    duties: [W],
    sops: ['R'],
  },
  {
    code: 'FLOOR_MANAGER',
    title: 'Floor Manager',
    home: 'FLOOR-SERVICE',
    duties: [D, 'WRITES_SHIFT_BRIEFING'],
    sops: ['B'],
  },
  {
    code: 'SERVER',
    title: 'Server',
    alsoCalled: ['Floor Staff'],
    home: 'FLOOR-SERVICE',
    duties: [W],
    sops: ['B'],
  },
  {
    code: 'CASHIER',
    title: 'Cashier',
    home: 'FLOOR-SERVICE',
    duties: [W, 'UPLOADS_POS_SALES'],
    sops: ['R'],
  },

  // counter (QSR, café)
  {
    code: 'SHIFT_MANAGER',
    title: 'Shift Manager',
    home: 'COUNTER',
    duties: [L, 'USES_DEPARTMENT_STORE', W],
    sops: ['Q'],
  },
  { code: 'CREW_TRAINER', title: 'Crew Trainer', home: 'COUNTER', duties: [W], sops: ['Q'] },
  {
    code: 'CREW_MEMBER',
    title: 'Crew Member',
    home: 'COUNTER',
    duties: [W, 'MAKES_PREP'],
    sops: ['Q'],
  },

  // in-room dining, banquets, events
  {
    code: 'IRD_MANAGER',
    title: 'In-Room Dining Manager',
    home: 'IN-ROOM-DINING',
    duties: [D, 'WRITES_SHIFT_BRIEFING'],
    sops: ['H'],
  },
  {
    code: 'IRD_ORDER_TAKER',
    title: 'In-Room Dining Order Taker',
    home: 'IN-ROOM-DINING',
    duties: [W],
    sops: ['H'],
  },
  {
    code: 'BANQUET_MANAGER',
    title: 'Banquet Manager',
    home: 'BANQUETS',
    duties: [D, 'PLANS_EVENTS', 'WRITES_SHIFT_BRIEFING'],
    sops: ['H'],
  },
  {
    code: 'BANQUET_CAPTAIN',
    title: 'Banquet Captain',
    home: 'BANQUETS',
    duties: [L, W],
    sops: ['H'],
  },
  { code: 'BANQUET_SERVER', title: 'Banquet Server', home: 'BANQUETS', duties: [W], sops: ['H'] },
  {
    code: 'EVENTS_MANAGER',
    title: 'Events Manager',
    alsoCalled: ['Entertainment Manager'],
    home: 'EVENTS',
    duties: [D, 'PLANS_EVENTS'],
    sops: ['B'],
  },

  // front office
  {
    code: 'FRONT_OFFICE_MANAGER',
    title: 'Front Office Manager',
    home: 'FRONT-OFFICE',
    duties: [D],
    sops: ['H'],
  },
  {
    code: 'FRONT_DESK_EXECUTIVE',
    title: 'Front Desk Executive',
    alsoCalled: ['Guest Service Associate'],
    home: 'FRONT-OFFICE',
    duties: [W],
    sops: ['H'],
  },
  {
    code: 'GUEST_RELATIONS_EXECUTIVE',
    title: 'Guest Relations Executive',
    home: 'FRONT-OFFICE',
    duties: [W],
    sops: ['H'],
  },
  {
    code: 'RESERVATIONS_EXECUTIVE',
    title: 'Reservations Executive',
    home: 'FRONT-OFFICE',
    duties: [W],
    sops: ['H'],
  },
  { code: 'CONCIERGE', title: 'Concierge', home: 'FRONT-OFFICE', duties: [W], sops: ['H'] },
  { code: 'NIGHT_AUDITOR', title: 'Night Auditor', home: 'FRONT-OFFICE', duties: [W], sops: ['H'] },
  {
    code: 'BELL_CAPTAIN',
    title: 'Bell Captain',
    home: 'FRONT-OFFICE',
    duties: [L, W],
    sops: ['H'],
  },
  {
    code: 'BELLBOY',
    title: 'Bellboy',
    alsoCalled: ['Bell Desk'],
    home: 'FRONT-OFFICE',
    duties: [W],
    sops: ['H'],
  },

  // housekeeping
  {
    code: 'EXECUTIVE_HOUSEKEEPER',
    title: 'Executive Housekeeper',
    home: 'HOUSEKEEPING',
    duties: [D, 'KEEPS_DEPARTMENT_STORE'],
    sops: ['H'],
  },
  {
    code: 'HOUSEKEEPING_SUPERVISOR',
    title: 'Housekeeping Supervisor',
    alsoCalled: ['Floor Supervisor'],
    home: 'HOUSEKEEPING',
    duties: [L, 'USES_DEPARTMENT_STORE', W],
    sops: ['H'],
  },
  {
    code: 'LAUNDRY_MANAGER',
    title: 'Laundry Manager',
    home: 'HOUSEKEEPING',
    duties: [L, 'USES_DEPARTMENT_STORE', W],
    sops: ['H'],
  },
  {
    code: 'ROOM_ATTENDANT',
    title: 'Room Attendant',
    home: 'HOUSEKEEPING',
    duties: [W],
    sops: ['H'],
  },
  {
    code: 'PUBLIC_AREA_ATTENDANT',
    title: 'Public Area Attendant',
    home: 'HOUSEKEEPING',
    duties: [W],
    sops: ['H'],
  },
  {
    code: 'LAUNDRY_ATTENDANT',
    title: 'Laundry Attendant',
    home: 'HOUSEKEEPING',
    duties: [W, 'USES_DEPARTMENT_STORE'],
    sops: ['H'],
  },

  // stores and purchase
  // the hotel SOP's head of Purchase and Stores (decided 7 Oct: "Store Manager" is this role)
  {
    code: 'PURCHASE_MANAGER',
    title: 'Purchase Manager',
    alsoCalled: ['Store Manager', 'Stores Manager', 'Purchase Executive', 'Purchase Officer'],
    home: 'STORES-TEAM',
    duties: [D, 'KEEPS_MAIN_STORE', 'SEES_OUTLET_STOCK'],
    sops: ['R', 'H'],
  },
  {
    code: 'STORE_KEEPER',
    title: 'Store Keeper',
    alsoCalled: ['Storekeeper'],
    home: 'STORES-TEAM',
    duties: ['KEEPS_MAIN_STORE', W],
    sops: ['R', 'C', 'H'],
  },
  {
    code: 'RECEIVING_CLERK',
    title: 'Receiving Clerk',
    home: 'STORES-TEAM',
    duties: ['USES_MAIN_STORE', W],
    sops: ['H'],
  },

  // engineering and security
  {
    code: 'CHIEF_ENGINEER',
    title: 'Chief Engineer',
    home: 'ENGINEERING',
    duties: [D],
    sops: ['H'],
  },
  {
    code: 'SHIFT_ENGINEER',
    title: 'Shift Engineer',
    alsoCalled: ['Assistant Engineer'],
    home: 'ENGINEERING',
    duties: [L, W],
    sops: ['H'],
  },
  { code: 'TECHNICIAN', title: 'Technician', home: 'ENGINEERING', duties: [W], sops: ['H'] },
  {
    code: 'SECURITY_SUPERVISOR',
    title: 'Security Supervisor',
    alsoCalled: ['Security Manager', 'Security Head'],
    home: 'SECURITY',
    duties: [D],
    sops: ['H', 'B'],
  },
  {
    code: 'SECURITY_GUARD',
    title: 'Security Guard',
    alsoCalled: ['Bouncer'],
    home: 'SECURITY',
    duties: [W],
    sops: ['H', 'B'],
  },

  // admin, finance, HR, IT, sales
  {
    code: 'HR_EXECUTIVE',
    title: 'HR Executive',
    home: 'ADMIN-FINANCE',
    duties: ['RUNS_OUTLET_HR', W],
    sops: ['H'],
  },
  {
    code: 'COST_CONTROLLER',
    title: 'Cost Controller',
    home: 'ADMIN-FINANCE',
    duties: ['CONTROLS_COSTS', W],
    sops: ['H'],
  },
  {
    code: 'FINANCIAL_CONTROLLER',
    title: 'Financial Controller',
    home: 'ADMIN-FINANCE',
    duties: [D, 'CONTROLS_COSTS'],
    sops: ['H'],
  },
  {
    code: 'ACCOUNTANT',
    title: 'Accountant',
    alsoCalled: ['Excise Clerk', 'Stock Verifier'],
    home: 'ADMIN-FINANCE',
    duties: [W],
    // the bar SOP's monthly stock count is the Accountant / Excise Clerk's, with the GM (LC-07)
    formatDuties: { bar_pub: ['VERIFIES_STOCK_CHECKS'] },
    formatHome: { bar_pub: '(outlet)' },
    sops: ['R', 'B', 'C', 'H'],
  },
  {
    code: 'INCOME_AUDITOR',
    title: 'Income Auditor',
    home: 'ADMIN-FINANCE',
    duties: [W],
    sops: ['H'],
  },
  {
    code: 'GENERAL_CASHIER',
    title: 'General Cashier',
    home: 'ADMIN-FINANCE',
    duties: [W],
    sops: ['H'],
  },
  {
    code: 'HR_MANAGER',
    title: 'HR Manager',
    home: 'HR',
    duties: [D, 'RUNS_OUTLET_HR'],
    sops: ['H'],
  },
  { code: 'IT_MANAGER', title: 'IT Manager', home: 'IT', duties: [D], sops: ['H'] },
  { code: 'IT_EXECUTIVE', title: 'IT Executive', home: 'IT', duties: [W], sops: ['H'] },
  {
    code: 'DIRECTOR_OF_SALES',
    title: 'Director of Sales & Marketing',
    home: 'SALES-MARKETING',
    duties: [D, 'PLANS_EVENTS'],
    sops: ['H'],
  },
  {
    code: 'SALES_MANAGER',
    title: 'Sales Manager',
    alsoCalled: ['Catering Sales Manager'],
    home: 'SALES-MARKETING',
    duties: [W],
    sops: ['H'],
  },
  {
    code: 'REVENUE_MANAGER',
    title: 'Revenue Manager',
    home: 'SALES-MARKETING',
    duties: [W],
    sops: ['H'],
  },
  {
    code: 'ONLINE_PLATFORM_MANAGER',
    title: 'Online Platform Manager',
    home: 'SALES-MARKETING',
    duties: [W, 'UPLOADS_POS_SALES'],
    sops: ['C'],
  },

  // spa and recreation
  {
    code: 'SPA_MANAGER',
    title: 'Spa Manager',
    home: 'SPA-RECREATION',
    duties: [D, 'KEEPS_DEPARTMENT_STORE'],
    sops: ['H'],
  },
  { code: 'THERAPIST', title: 'Therapist', home: 'SPA-RECREATION', duties: [W], sops: ['H'] },
  {
    code: 'SPA_RECEPTIONIST',
    title: 'Spa Receptionist',
    home: 'SPA-RECREATION',
    duties: [W],
    sops: ['H'],
  },
  {
    code: 'RECREATION_MANAGER',
    title: 'Recreation Manager',
    home: 'SPA-RECREATION',
    duties: [L, W],
    sops: ['H'],
  },
  { code: 'LIFEGUARD', title: 'Lifeguard', home: 'SPA-RECREATION', duties: [W], sops: ['H'] },
  {
    code: 'KIDS_CLUB_SUPERVISOR',
    title: "Kids' Club Supervisor",
    home: 'SPA-RECREATION',
    duties: [L, W],
    sops: ['H'],
  },

  // packing and dispatch (cloud kitchen), delivery
  {
    code: 'PACKER',
    title: 'Packer',
    alsoCalled: ['Dispatcher'],
    home: 'DISPATCH',
    duties: [W],
    sops: ['C'],
  },
  {
    code: 'DELIVERY_DRIVER',
    title: 'Delivery Driver',
    alsoCalled: ['Rider'],
    home: 'CENTRAL-KITCHEN-DISPATCH-TEAM',
    duties: [W],
    sops: ['C', 'Q'],
  },

  // central kitchen
  {
    code: 'CENTRAL_KITCHEN_MANAGER',
    title: 'Central Kitchen Manager',
    alsoCalled: ['Commissary Manager'],
    home: 'CENTRAL-KITCHEN-DISPATCH-TEAM',
    duties: ['RUNS_CENTRAL_KITCHEN_STORE', D],
    sops: ['Q'],
  },
  {
    code: 'CENTRAL_KITCHEN_SUPERVISOR',
    title: 'Central Kitchen Supervisor',
    home: 'CENTRAL-KITCHEN-PRODUCTION',
    duties: ['RUNS_CENTRAL_KITCHEN'],
    sops: ['Q'],
  },
  {
    code: 'CENTRAL_KITCHEN_CHEF',
    title: 'Central Kitchen Chef',
    home: 'CENTRAL-KITCHEN-PRODUCTION',
    duties: ['USES_CENTRAL_KITCHEN_STORE', W],
    sops: ['Q'],
  },
  {
    code: 'CENTRAL_KITCHEN_COMMIS',
    title: 'Central Kitchen Commis',
    home: 'CENTRAL-KITCHEN-PRODUCTION',
    duties: [W, 'MAKES_PREP'],
    sops: ['Q'],
  },
  {
    code: 'CENTRAL_KITCHEN_STORE_KEEPER',
    title: 'Central Kitchen Store Keeper',
    home: 'CENTRAL-KITCHEN-DISPATCH-TEAM',
    duties: ['KEEPS_CENTRAL_KITCHEN_STORE', W],
    sops: ['Q'],
  },
];

export const ROLE_BY_CODE: ReadonlyMap<string, RoleDef> = new Map(ROLES.map((r) => [r.code, r]));

/** The five rungs (docs/templates-and-cover.md), lowest first. */
export const LEVELS = [
  'works',
  'leads_shift',
  'runs_department',
  'runs_outlet',
  'above_outlet',
] as const;
export type Level = (typeof LEVELS)[number];

/** The rung a duty puts its holder on; duties not listed say nothing about it. */
const DUTY_LEVEL: Readonly<Record<string, Level>> = {
  OWNS_COMPANY_ACCOUNT: 'above_outlet',
  RUNS_AREA: 'above_outlet',
  RUNS_COMPANY_HR: 'above_outlet',
  APPROVES_ACCESS: 'above_outlet',
  AUDITS_COMPANY: 'above_outlet',
  RUNS_OUTLET: 'runs_outlet',
  RUNS_CENTRAL_KITCHEN: 'runs_outlet',
  RUNS_DEPARTMENT: 'runs_department',
  LEADS_SHIFT: 'leads_shift',
  KEEPS_MAIN_STORE: 'leads_shift',
  KEEPS_DEPARTMENT_STORE: 'leads_shift',
  KEEPS_CENTRAL_KITCHEN_STORE: 'leads_shift',
};

/**
 * A role's level is worked out from its duties, never set by hand: the highest rung any of
 * them puts the holder on, else "works". So a level can never disagree with what the role
 * may do. Step 4 (cover) uses it to find who a duty falls up to.
 */
export function levelOf(duties: readonly string[]): Level {
  let best = 0;
  for (const d of duties) {
    const l = DUTY_LEVEL[d.split('@')[0]!];
    if (l) best = Math.max(best, LEVELS.indexOf(l));
  }
  return LEVELS[best]!;
}

/** Checks the catalogue; throws on the first problem. */
export function checkCatalogue(
  roles: readonly RoleDef[] = ROLES,
  departments: readonly DepartmentDef[] = DEPARTMENTS,
): void {
  for (const code of Object.keys(DUTY_LEVEL)) {
    if (!DUTY_BY_CODE.has(code)) throw new Error(`level rule for unknown duty ${code}`);
  }
  const depts = new Set<string>();
  for (const d of departments) {
    if (!/^[A-Z][A-Z0-9-]*$/.test(d.code)) throw new Error(`bad department code ${d.code}`);
    if (depts.has(d.code)) throw new Error(`department ${d.code} listed twice`);
    depts.add(d.code);
  }
  const codes = new Set<string>();
  const titles = new Map<string, RoleDef>();
  for (const r of roles) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(r.code)) throw new Error(`bad role code ${r.code}`);
    if (codes.has(r.code)) throw new Error(`role ${r.code} listed twice`);
    codes.add(r.code);
    // two SOPs may use one title for different jobs (a hotel's Store Manager heads Stores, a
    // QSR's runs the outlet): allowed only where the two work in different places
    const same = titles.get(r.title);
    if (same && same.home === r.home) {
      throw new Error(`roles ${same.code} and ${r.code} share the title ${r.title}`);
    }
    titles.set(r.title, r);
    if (
      !depts.has(r.home) &&
      !(ROLE_HOMES_WITHOUT_DEPARTMENT as readonly string[]).includes(r.home)
    ) {
      throw new Error(`role ${r.code}: ${r.home} is not a department`);
    }
    for (const list of [r.duties, ...Object.values(r.formatDuties ?? {})]) {
      if (!list || list.length === 0) throw new Error(`role ${r.code} has no duties`);
      const grants = new Set<string>();
      for (const entry of list) {
        const [code, at] = entry.split('@');
        // throws on an unknown duty or a department it cannot be given at
        for (const g of expandDuty(code!, at)) {
          const k = `${g.group}@${g.scope}`;
          if (grants.has(k)) throw new Error(`role ${r.code}: ${k} given twice`);
          grants.add(k);
        }
      }
    }
  }
}

const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const SOP_NAMES: Readonly<Record<Sop, string>> = {
  R: 'Restaurant',
  B: 'Bar',
  C: 'Cloud kitchen',
  F: 'Franchise',
  H: 'Hotel',
  Q: 'QSR',
};

/**
 * The catalogue as the two reference files in docs/onboarding/test-data
 * (`PRODUCT_roles_REFERENCE.csv`, `PRODUCT_departments_REFERENCE.csv`); a test keeps them in
 * step. Regenerate with `pnpm --filter @outlet-ops/onboarding catalogue-reference`.
 */
export function catalogueReference(): { roles: string; departments: string } {
  const roles = [
    'job_role_code,job_title,also_called,level,usual_department,default_duties,format_duties,from_sops',
    ...ROLES.map((r) =>
      [
        r.code,
        r.title,
        (r.alsoCalled ?? []).join('; '),
        levelOf(r.duties),
        r.home,
        r.duties.join('; '),
        Object.entries(r.formatDuties ?? {})
          .map(([f, d]) => `${f}: ${(d ?? []).join('; ')}`)
          .join(' | '),
        r.sops.length ? r.sops.map((s) => SOP_NAMES[s]).join('; ') : '(the app)',
      ]
        .map(cell)
        .join(','),
    ),
  ];
  const departments = [
    'department_code,name,department_type,usual_store,from_sops',
    ...DEPARTMENTS.map((d) =>
      [d.code, d.name, d.type, d.store ?? '', d.sops.map((s) => SOP_NAMES[s]).join('; ')]
        .map(cell)
        .join(','),
    ),
  ];
  return { roles: roles.join('\n') + '\n', departments: departments.join('\n') + '\n' };
}
