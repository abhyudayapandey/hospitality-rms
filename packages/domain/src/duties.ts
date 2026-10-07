// Duties (ADR 058, 059): one piece of responsibility, in plain words, over the access-group
// grants it stands for. A job role holds duties; each duty expands to GROUP@scope grants that
// `core.derive_job_role_access_at` resolves from the person's home place, exactly as before
// duties existed. Product code like the access groups: the workflow package's product sync
// writes it into every tenant (`hr.duty`, `hr.duty_grant`, authoritative).
//
// Step 1 of docs/templates-and-cover.md: a duty is as fine as today's groups and scopes, so
// no one's access changes. Later steps (cover, templates) move duties between roles.

import { ACCESS_GROUPS } from './access';

/** Where a grant applies, resolved from the person's home place (ADR 009). */
export const SCOPE_WORDS = [
  'home_department',
  'whole_outlet',
  'outlet_stores',
  'department_store',
  'main_store',
  'central_kitchen',
  'central_kitchen_store',
  'whole_area',
  'whole_company',
] as const;
export type ScopeWord = (typeof SCOPE_WORDS)[number];

/** `department:<CODE>`: the department `<outlet code>-<CODE>` of the person's outlet. */
export const DEPARTMENT_SCOPE = /^department:[A-Z0-9][A-Z0-9-]*$/;

export function isScope(scope: string): boolean {
  return (SCOPE_WORDS as readonly string[]).includes(scope) || DEPARTMENT_SCOPE.test(scope);
}

export interface DutyGrant {
  group: string;
  scope: ScopeWord;
  /** `(this store only)`: the grant does not reach the places below. */
  thisPlaceOnly?: true;
}

export interface DutyDef {
  code: string;
  /** What it is, as a person would say it. */
  name: string;
  /** What the person can do because of it. */
  does: string;
  grants: readonly DutyGrant[];
  /** A role may hold it at another department of its outlet (`DUTY@department:BAR`). */
  atAnotherDepartment?: true;
}

export const DUTIES: readonly DutyDef[] = [
  {
    code: 'OWNS_COMPANY_ACCOUNT',
    name: 'Owns the company account',
    does: 'Sees every report read-only, sets company settings and modules, ends every approval chain',
    grants: [{ group: 'ACCOUNT_OWNER', scope: 'whole_company' }],
  },
  {
    code: 'RUNS_AREA',
    name: 'Looks after the area',
    does: "Sees the area's outlets and approves what reaches the area",
    grants: [{ group: 'AREA_MANAGER', scope: 'whole_area' }],
  },
  {
    code: 'RUNS_COMPANY_HR',
    name: 'Runs HR for the company',
    does: "Looks after every outlet's people records, leave and labour cost",
    grants: [{ group: 'HR_ADMIN', scope: 'whole_company' }],
  },
  {
    code: 'APPROVES_ACCESS',
    name: 'Approves access changes',
    does: 'Approves role changes and leavers for the company',
    grants: [{ group: 'SECURITY_ADMIN', scope: 'whole_company' }],
  },
  {
    code: 'AUDITS_COMPANY',
    name: 'Audits the company',
    does: 'Reads the audit log and access across the company',
    grants: [{ group: 'AUDITOR', scope: 'whole_company' }],
  },
  {
    code: 'RUNS_OUTLET',
    name: 'Runs the outlet',
    does: "Runs every department and store of the outlet, approves the outlet's requests, sees its reports",
    grants: [
      { group: 'OUTLET_MANAGER', scope: 'whole_outlet' },
      { group: 'OUTLET_MANAGER', scope: 'outlet_stores' },
    ],
  },
  {
    code: 'RUNS_OUTLET_HR',
    name: "Looks after the outlet's people",
    does: "Keeps the outlet's people records and leave",
    grants: [{ group: 'OUTLET_HR', scope: 'whole_outlet' }],
  },
  {
    code: 'CONTROLS_COSTS',
    name: "Controls the outlet's costs",
    does: "Sees the outlet's stock and cost reports, sets menu prices and verifies stock checks",
    grants: [{ group: 'COST_CONTROLLER', scope: 'outlet_stores' }],
  },
  {
    code: 'VERIFIES_STOCK_CHECKS',
    name: 'Verifies stock checks',
    does: "Verifies the differences found in the outlet's stock checks",
    grants: [{ group: 'STOCK_VERIFIER', scope: 'outlet_stores' }],
  },
  {
    code: 'SEES_OUTLET_STOCK',
    name: "Sees the outlet's stock",
    does: 'Sees the stock in every store of the outlet',
    grants: [{ group: 'SUPPLY_VIEWER', scope: 'outlet_stores' }],
  },
  {
    code: 'RUNS_DEPARTMENT',
    name: 'Runs the department',
    does: "Builds the roster, resolves attendance, approves the department's leave, swaps and unusual requests",
    grants: [{ group: 'DEPARTMENT_HEAD', scope: 'home_department' }],
    atAnotherDepartment: true,
  },
  {
    code: 'WRITES_SHIFT_BRIEFING',
    name: 'Writes the shift briefing',
    does: "Writes today's note for the outlet's shift: specials, dishes that are off, guests to know about, targets",
    grants: [{ group: 'BRIEFING_WRITER', scope: 'home_department' }],
    atAnotherDepartment: true,
  },
  {
    code: 'LEADS_SHIFT',
    name: 'Leads the shift',
    does: "Gives out the department's tasks and sees its attendance",
    grants: [{ group: 'SUPERVISOR', scope: 'home_department' }],
  },
  {
    code: 'WORKS_SHIFTS',
    name: 'Works shifts in the department',
    does: "Sees the department's roster, events and recipes",
    grants: [{ group: 'STAFF', scope: 'home_department' }],
  },
  {
    code: 'MAKES_PREP',
    name: 'Makes prep',
    does: 'Records the batches they make',
    grants: [{ group: 'PRODUCTION_TEAM', scope: 'home_department' }],
  },
  {
    code: 'USES_DEPARTMENT_STORE',
    name: "Uses the department's store",
    does: "Counts, records wastage and asks for stock in the department's store",
    grants: [{ group: 'STOCK_USER', scope: 'department_store' }],
  },
  {
    code: 'KEEPS_DEPARTMENT_STORE',
    name: "Keeps the department's store",
    does: "Runs the department's store: stock, counts, requests and receiving",
    grants: [{ group: 'STORE_KEEPER', scope: 'department_store' }],
  },
  {
    code: 'KEEPS_MAIN_STORE',
    name: 'Keeps the Main Store',
    does: 'Orders from suppliers, receives deliveries and sends stock to the departments',
    grants: [{ group: 'STORE_KEEPER', scope: 'main_store' }],
  },
  {
    code: 'USES_MAIN_STORE',
    name: 'Receives at the Main Store',
    does: 'Receives deliveries and counts stock at the Main Store',
    grants: [{ group: 'STOCK_USER', scope: 'main_store' }],
  },
  {
    code: 'PLANS_EVENTS',
    name: 'Plans events',
    does: "Adds and changes the outlet's events",
    grants: [{ group: 'EVENT_PLANNER', scope: 'whole_outlet' }],
  },
  {
    code: 'UPLOADS_POS_SALES',
    name: "Uploads the day's POS sales",
    does: 'Uploads the POS file and matches its codes to dishes',
    grants: [{ group: 'CASHIER', scope: 'outlet_stores' }],
  },
  {
    code: 'RUNS_CENTRAL_KITCHEN',
    name: 'Runs the central kitchen',
    does: 'Runs the central kitchen site and its people',
    grants: [{ group: 'OUTLET_MANAGER', scope: 'central_kitchen' }],
  },
  {
    code: 'RUNS_CENTRAL_KITCHEN_STORE',
    name: "Runs the central kitchen's store",
    does: "Sends prep to the outlets and sees the central kitchen's stock",
    grants: [
      { group: 'HUB_MANAGER', scope: 'central_kitchen_store', thisPlaceOnly: true },
      { group: 'SUPPLY_VIEWER', scope: 'central_kitchen_store' },
    ],
  },
  {
    code: 'KEEPS_CENTRAL_KITCHEN_STORE',
    name: "Keeps the central kitchen's store",
    does: "Runs the central kitchen's store: stock, counts and dispatch",
    grants: [{ group: 'STORE_KEEPER', scope: 'central_kitchen_store', thisPlaceOnly: true }],
  },
  {
    code: 'USES_CENTRAL_KITCHEN_STORE',
    name: "Uses the central kitchen's store",
    does: "Counts and records wastage in the central kitchen's store",
    grants: [{ group: 'STOCK_USER', scope: 'central_kitchen_store', thisPlaceOnly: true }],
  },
];

export const DUTY_BY_CODE: ReadonlyMap<string, DutyDef> = new Map(DUTIES.map((d) => [d.code, d]));

/** One grant a role gets, with the duty it comes from. */
export interface DutyAccess {
  duty: string;
  group: string;
  scope: string;
  includeDescendants: boolean;
}

/**
 * The grants a duty stands for. `at` gives it at another department of the outlet
 * (`department:BAR`) and is only allowed for duties marked `atAnotherDepartment`.
 */
export function expandDuty(code: string, at?: string): DutyAccess[] {
  const d = DUTY_BY_CODE.get(code);
  if (!d) throw new Error(`${code} is not a duty`);
  if (at !== undefined && (!d.atAnotherDepartment || !DEPARTMENT_SCOPE.test(at))) {
    throw new Error(`${code} cannot be given at ${at}`);
  }
  return d.grants.map((g) => ({
    duty: d.code,
    group: g.group,
    scope: at ?? g.scope,
    includeDescendants: !g.thisPlaceOnly,
  }));
}

/** Checks the catalogue against the access groups; throws on the first problem. */
export function checkDuties(duties: readonly DutyDef[] = DUTIES): void {
  const groups = new Set(ACCESS_GROUPS.map((g) => g.code));
  const seen = new Set<string>();
  for (const d of duties) {
    if (!/^[A-Z][A-Z0-9_]{2,59}$/.test(d.code)) throw new Error(`bad duty code ${d.code}`);
    if (seen.has(d.code)) throw new Error(`duty ${d.code} listed twice`);
    seen.add(d.code);
    if (d.grants.length === 0) throw new Error(`duty ${d.code} has no grants`);
    if (d.atAnotherDepartment && d.grants.length !== 1) {
      throw new Error(`duty ${d.code}: only a one-grant duty can be given at another department`);
    }
    const pairs = new Set<string>();
    for (const g of d.grants) {
      if (!groups.has(g.group))
        throw new Error(`duty ${d.code}: ${g.group} is not an access group`);
      if (!isScope(g.scope)) throw new Error(`duty ${d.code}: ${g.scope} is not a scope`);
      const k = `${g.group}@${g.scope}`;
      if (pairs.has(k)) throw new Error(`duty ${d.code}: ${k} listed twice`);
      pairs.add(k);
    }
  }
}
