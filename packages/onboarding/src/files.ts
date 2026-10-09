import { z } from 'zod';
import {
  DUTY_BY_CODE,
  MODULE_CODES,
  type ModuleCode,
  OUTLET_FORMATS,
  outletFormat,
  type OutletFormat,
  ROLE_BY_CODE,
  SCOPE_WORDS,
  expandDuty,
  ALLERGENS,
  FOOD_TYPES,
  parseAllergens,
  isTaskIcon,
  TASK_ICONS,
} from '@outlet-ops/domain';
import { CsvError, parseCsv } from './csv';

// The onboarding files (docs/onboarding/test-data/README.md): one zod schema per file turns
// a row of strings into typed values. Every problem is reported with its file, line and
// column so the Platform Admin console can point at the cell.

export interface Issue {
  file: string;
  /** 1-based line in the file (the header is line 1); absent for whole-file problems. */
  row?: number;
  column?: string;
  message: string;
}

const text = z.string().min(1, 'is required');
const optional = z.string().transform((v) => (v === '' ? undefined : v));
const code = z.string().regex(/^[A-Z0-9][A-Z0-9_.-]*$/, 'must be an upper-case code');
const optCode = z.union([z.literal('').transform(() => undefined), code]);
const yesNo = z.enum(['yes', 'no'], 'must be yes or no').transform((v) => v === 'yes');
const keepYesNo = z.union([z.literal('').transform(() => undefined), yesNo]);
const num = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'must be a number')
  .transform(Number);
const optNum = z.union([z.literal('').transform(() => undefined), num]);
const int = z.string().regex(/^\d+$/, 'must be a whole number').transform(Number);
/** A phone number for WhatsApp (PO-4): digits, spaces, brackets and dashes, 8 to 15 digits. */
const phone = z
  .string()
  .refine(
    (v) => v === '' || (/^\+?[0-9 ()-]+$/.test(v) && /^(\D*\d){8,15}\D*$/.test(v)),
    'must be a phone number with 8 to 15 digits',
  )
  .transform((v) => (v === '' ? undefined : v));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date like 2026-10-01');
const optDate = z.union([z.literal('').transform(() => undefined), date]);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time like 07:00');
const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/, 'must be like 2026-10-17 18:00');
/** Days from the load date: 0 is the load day, -1 the day before (test-only files). */
const dayOffset = z
  .string()
  .regex(/^(0|-[1-9]\d?)$/, 'must be 0 or a day before it, like -3')
  .transform(Number)
  .refine((v) => v >= -30, 'must be within the last 30 days');
const recipeUnit = z.enum(['g', 'ml', 'each'], 'must be g, ml or each');
const timezone = z.string().refine(isTimezone, 'is not a known time zone');
const optTimezone = z.union([z.literal('').transform(() => undefined), timezone]);

// The SOPs' formats (ADR 062); a file may still use an old code, read as the new one.
const FORMAT_MESSAGE = `must be one of ${OUTLET_FORMATS.join(', ')}`;
const toFormat = (v: string, ctx: z.RefinementCtx) => {
  const f = outletFormat(v);
  if (f) return f;
  ctx.addIssue({ code: 'custom', message: FORMAT_MESSAGE });
  return z.NEVER;
};
/** An outlet's format (file 01): blank for anything but an outlet. */
const outletFormatColumn = z
  .string()
  .transform((v, ctx) => (v === '' ? undefined : toFormat(v, ctx)));
/** The format a job role's row is for (file 06): `any`, or one format. */
const roleFormatColumn = z
  .string()
  .transform((v, ctx): 'any' | OutletFormat => (v === 'any' ? 'any' : toFormat(v, ctx)));
/** What a department does, for the order of Home's "Needs attention" (DB-2, ADR 033). */
export const DEPARTMENT_TYPES = ['kitchen', 'service', 'housekeeping', 'other'] as const;
/** Scope words for job-role access (ADR 009), defined with the duties (ADR 059). */
export const SCOPES = SCOPE_WORDS;

function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface AccessDefault {
  group: string;
  scope: string;
  includeDescendants: boolean;
  /** The duty the grant comes from (`default_duties`, ADR 059); absent for a direct grant. */
  duty?: string;
}

/** `OUTLET_MANAGER@whole_outlet; HUB_MANAGER@central_kitchen_store(this store only)` */
const rights = z.string().transform((v, ctx): Record<string, 'view' | 'modify'> => {
  const out: Record<string, 'view' | 'modify'> = {};
  for (const part of v
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m = /^([A-Z][A-Z_]*):(view|modify)$/.exec(part);
    if (!m) {
      ctx.addIssue({ code: 'custom', message: `"${part}" is not DOMAIN:view or DOMAIN:modify` });
      continue;
    }
    out[m[1]!] = m[2] as 'view' | 'modify';
  }
  return out;
});

const defaultAccess = z.string().transform((v, ctx): AccessDefault[] => {
  const out: AccessDefault[] = [];
  for (const part of v
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m =
      /^([A-Z][A-Z0-9_]*)@([a-z_]+|department:[A-Z0-9][A-Z0-9-]*)(\(this store only\))?$/.exec(
        part,
      );
    if (!m || !(m[2]!.startsWith('department:') || (SCOPES as readonly string[]).includes(m[2]!))) {
      ctx.addIssue({ code: 'custom', message: `"${part}" is not GROUP@scope` });
      continue;
    }
    out.push({ group: m[1]!, scope: m[2]!, includeDescendants: !m[3] });
  }
  return out;
});

/** `RUNS_DEPARTMENT; RUNS_DEPARTMENT@department:BAR; KEEPS_DEPARTMENT_STORE` (ADR 059) */
const defaultDuties = z.string().transform((v, ctx): AccessDefault[] =>
  dutyGrants(
    v
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean),
    (message) => ctx.addIssue({ code: 'custom', message }),
  ),
);

/** The grants of a list of duties (`DUTY` or `DUTY@department:CODE`); problems go to `fail`. */
function dutyGrants(parts: readonly string[], fail: (message: string) => void): AccessDefault[] {
  const out: AccessDefault[] = [];
  for (const part of parts) {
    const m = /^([A-Z][A-Z0-9_]*)(?:@(department:[A-Z0-9][A-Z0-9-]*))?$/.exec(part);
    if (!m) {
      fail(`"${part}" is not DUTY or DUTY@department:CODE`);
      continue;
    }
    const duty = DUTY_BY_CODE.get(m[1]!);
    if (!duty) {
      fail(`${m[1]} is not a duty`);
      continue;
    }
    if (m[2] && !duty.atAnotherDepartment) {
      fail(`${m[1]} cannot be given at another department`);
      continue;
    }
    for (const g of expandDuty(duty.code, m[2])) {
      out.push({
        group: g.group,
        scope: g.scope,
        includeDescendants: g.includeDescendants,
        duty: g.duty,
      });
    }
  }
  return out;
}

const DAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as const;
type Day = keyof typeof DAY;
/** `Mon-Sun`, `Fri-Sat`, `Mon,Wed,Fri` -> ISO weekdays */
const days = z.string().transform((v, ctx) => {
  const set = new Set<number>();
  for (const part of v.split(',').map((p) => p.trim())) {
    const m = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:-(Mon|Tue|Wed|Thu|Fri|Sat|Sun))?$/.exec(part);
    if (!m) {
      ctx.addIssue({ code: 'custom', message: `"${part}" is not a day or day range` });
      continue;
    }
    const from = DAY[m[1] as Day];
    const to = DAY[(m[2] ?? m[1]) as Day];
    for (let d = from; ; d = (d % 7) + 1) {
      set.add(d);
      if (d === to) break;
    }
  }
  return [...set].sort();
});

export type Requirement =
  | { kind: 'item'; item: string; qty: number; unit: string }
  | { kind: 'role'; role: string; headcount: number; start: string; end: string };

/** `item PANEER = 20 kg; role BARTENDER = 3 (18:00-23:30)` */
export type Schedule =
  | { kind: 'daily'; times: string[] }
  | { kind: 'weekly'; weekdays: number[]; times: string[] }
  | { kind: 'every_n_hours'; every: number; from: string; to: string }
  | { kind: 'monthly'; days: number[]; times: string[] }
  | { kind: 'nth_weekday'; weekday: number; nths: number[]; times: string[] };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/**
 * A checklist's schedule (ADR 020, 087), times local to its place: `daily 07:00 15:00`,
 * `weekly Mon,Thu 09:00`, `every 2h 08:00-22:00`, `monthly 1,16 09:00` (days of the month; a
 * day past the month's end falls on its last day) or `nth Mon 1,3 10:00` (the 1st and 3rd
 * Monday).
 */
const schedule = z.string().transform((v, ctx): Schedule => {
  const parts = v.trim().split(/\s+/);
  const bad = (message: string) => {
    ctx.addIssue({ code: 'custom', message });
    return z.NEVER;
  };
  if (parts[0] === 'daily') {
    const times = parts.slice(1);
    if (times.length === 0 || !times.every((t) => HHMM.test(t))) {
      return bad('must be like "daily 07:00 15:00"');
    }
    return { kind: 'daily', times };
  }
  if (parts[0] === 'weekly') {
    const weekdays = new Set<number>();
    for (const d of (parts[1] ?? '').split(',')) {
      if (!(d in DAY)) return bad('must be like "weekly Mon,Thu 09:00"');
      weekdays.add(DAY[d as Day]);
    }
    const times = parts.slice(2);
    if (times.length === 0 || !times.every((t) => HHMM.test(t))) {
      return bad('must be like "weekly Mon,Thu 09:00"');
    }
    return { kind: 'weekly', weekdays: [...weekdays].sort(), times };
  }
  if (parts[0] === 'monthly') {
    const ds = (parts[1] ?? '').split(',').map(Number);
    const times = parts.slice(2);
    if (
      ds.some((d) => !Number.isInteger(d) || d < 1 || d > 31) ||
      times.length === 0 ||
      !times.every((t) => HHMM.test(t))
    ) {
      return bad('must be like "monthly 1,16 09:00" (days of the month 1 to 31)');
    }
    return { kind: 'monthly', days: [...new Set(ds)].sort((a, b) => a - b), times };
  }
  if (parts[0] === 'nth') {
    const weekday = DAY[parts[1] as Day];
    const nths = (parts[2] ?? '').split(',').map(Number);
    const times = parts.slice(3);
    if (
      !weekday ||
      nths.some((n) => ![1, 2, 3, 4].includes(n)) ||
      times.length === 0 ||
      !times.every((t) => HHMM.test(t))
    ) {
      return bad('must be like "nth Mon 1,3 10:00" (the 1st to 4th of a weekday)');
    }
    return { kind: 'nth_weekday', weekday, nths: [...new Set(nths)].sort(), times };
  }
  const m = /^every (1|2|3|4|6|8|12)h ([0-2]\d:[0-5]\d)-([0-2]\d:[0-5]\d)$/.exec(parts.join(' '));
  if (m && HHMM.test(m[2]!) && HHMM.test(m[3]!)) {
    return { kind: 'every_n_hours', every: Number(m[1]), from: m[2]!, to: m[3]! };
  }
  return bad(
    'must be "daily 07:00", "weekly Mon,Thu 09:00", "every 2h 08:00-22:00" (1, 2, 3, 4, 6, 8 or 12 hours), "monthly 1,16 09:00" or "nth Mon 1,3 10:00"',
  );
});

export type AssignTo =
  { mode: 'job_role'; role: string } | { mode: 'on_shift' } | { mode: 'person'; username: string };
/** Who a task goes to: `role:COMMIS`, `on_shift` or `person:test.commis.1.0`. */
const assignTo = z.string().transform((v, ctx): AssignTo => {
  if (v === 'on_shift') return { mode: 'on_shift' };
  const role = /^role:([A-Z][A-Z0-9_]*)$/.exec(v);
  if (role) return { mode: 'job_role', role: role[1]! };
  const person = /^person:(\S+)$/.exec(v);
  if (person) return { mode: 'person', username: person[1]! };
  ctx.addIssue({ code: 'custom', message: 'must be role:JOB_ROLE, on_shift or person:username' });
  return z.NEVER;
});
/** Days from the load date, before or after it (test-only tasks). */
const dayAround = z
  .string()
  .regex(/^(0|-?[1-9]\d?)$/, 'must be a whole number of days, like -1 or 2')
  .transform(Number)
  .refine((v) => v >= -14 && v <= 14, 'must be within 14 days of the load date');
const optYesNo = z.union([z.literal('').transform(() => false), yesNo]);

const requirements = z.string().transform((v, ctx): Requirement[] => {
  const out: Requirement[] = [];
  for (const part of v
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const item = /^item ([A-Z0-9][A-Z0-9_-]*) = (\d+(?:\.\d+)?) (\S+)$/.exec(part);
    const role = /^role ([A-Z][A-Z0-9_]*) = (\d+) \((\d\d:\d\d)-(\d\d:\d\d)\)$/.exec(part);
    if (item) out.push({ kind: 'item', item: item[1]!, qty: Number(item[2]), unit: item[3]! });
    else if (role)
      out.push({
        kind: 'role',
        role: role[1]!,
        headcount: Number(role[2]),
        start: role[3]!,
        end: role[4]!,
      });
    else ctx.addIssue({ code: 'custom', message: `"${part}" is not an item or role line` });
  }
  return out;
});

export const FILES = {
  customer: {
    file: '00_customer.csv',
    required: true,
    schema: z.object({
      customer_code: code,
      company_name: text,
      country: text,
      currency: z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter currency code'),
      default_timezone: timezone,
      // optional: the leave HR approval step (ADR 009); blank or absent keeps it on
      leave_hr_approval: z.union([z.literal('').transform(() => undefined), yesNo]),
      // optional: swaps for management only (SW-4, ADR 035); blank or absent leaves it as it
      // is (on for a new customer); the Account Owner can also change it in Admin → Settings
      swaps_managers_only: keepYesNo,
      // optional: a test customer (ADR 012); only when the customer is created, never changed
      is_test: z.union([z.literal('').transform(() => undefined), yesNo]),
      // optional: a column per block, on or off (ADR 026, 085); blank or absent leaves it as it
      // is (a new customer has every block on but Compliance). Only platform admins run imports,
      // so only they change blocks; a block is on only inside a bundle in the plan.
      ...(Object.fromEntries(MODULE_CODES.map((m) => [m, keepYesNo])) as Record<
        ModuleCode,
        typeof keepYesNo
      >),
    }),
    optional: ['leave_hr_approval', 'is_test', 'swaps_managers_only', ...MODULE_CODES],
  },
  orgNodes: {
    file: '01_org_nodes.csv',
    required: true,
    schema: z.object({
      node_code: code,
      name: text,
      kind: z.enum(['company', 'region', 'area', 'outlet', 'site', 'department']),
      parent_code: optCode,
      timezone: optTimezone,
      outlet_format: outletFormatColumn,
      // DB-2 (ADR 033): optional column, departments only; blank means other
      department_type: z
        .enum(['', ...DEPARTMENT_TYPES], 'must be kitchen, service, housekeeping or other')
        .transform((v) => (v === '' ? undefined : v))
        .optional(),
    }),
    optional: ['department_type'],
  },
  deliveryNodes: {
    file: '02_delivery_nodes.csv',
    required: true,
    schema: z.object({
      node_code: code,
      name: text,
      kind: z.enum(['network', 'hub', 'outlet', 'store']),
      parent_code: optCode,
      timezone: optTimezone,
      holds_stock: yesNo,
      is_main_store: yesNo,
    }),
  },
  nodeLinks: {
    file: '03_node_links.csv',
    required: true,
    schema: z.object({ org_node_code: code, delivery_node_code: code, note: optional }),
  },
  locations: {
    file: '04_location_settings.csv',
    required: false,
    schema: z.object({
      org_node_code: code,
      latitude: num.refine((v) => v >= -90 && v <= 90, 'must be between -90 and 90'),
      longitude: num.refine((v) => v >= -180 && v <= 180, 'must be between -180 and 180'),
      geofence_radius_m: int.refine((v) => v >= 10 && v <= 5000, 'must be 10 to 5000'),
    }),
  },
  // the customer's own access groups (ADR 027): rights "DOMAIN:view; DOMAIN:modify", and the
  // product roles whose request and approval duties the group carries
  customGroups: {
    file: '05_access_groups.csv',
    required: false,
    schema: z.object({
      group_code: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{2,39}$/, 'must be an upper-case code (3 to 40: A-Z 0-9 _)'),
      name: text,
      rights: rights,
      acts_as: z.string().transform((v) =>
        v
          .split(';')
          .map((p) => p.trim())
          .filter(Boolean),
      ),
    }),
  },
  jobRoles: {
    file: '06_job_roles.csv',
    required: true,
    schema: z.object({
      job_role_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an upper-case code'),
      // blank for a catalogue role: its title comes from the catalogue (ADR 060)
      job_title: optional,
      outlet_format: roleFormatColumn,
      usual_department: optional,
      default_duties: defaultDuties,
      default_access: defaultAccess,
    }),
    // a role lists its duties, or grants directly, or both (ADR 059); a catalogue role may
    // leave all of it blank (ADR 060)
    optional: ['job_title', 'usual_department', 'default_duties', 'default_access'],
  },
  users: {
    file: '07_users.csv',
    required: true,
    schema: z.object({
      username: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'must be lower case: a-z 0-9 . _ -'),
      display_name: text,
      job_role_code: text,
      home_node_code: code,
      login_type: z.enum(['username', 'email']),
      email: z.union([z.literal('').transform(() => undefined), z.email('is not an email')]),
      employment_type: z.enum(['full_time', 'part_time', 'casual']),
      joined_on: optDate,
      password_mode: optional,
      // a test customer's demo presenter, who may show the app as anyone (ADR 071)
      demo_presenter: optYesNo,
    }),
    optional: ['demo_presenter'],
  },
  extraAccess: {
    file: '08_role_assignments_extra.csv',
    required: false,
    schema: z.object({
      username: text,
      access_group: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an access group code'),
      node_code: code,
      include_descendants: z.enum(['true', 'false']).transform((v) => v === 'true'),
      reason: text,
    }),
  },
  suppliers: {
    file: '09_suppliers.csv',
    required: false,
    schema: z.object({
      supplier_code: code,
      name: text,
      lead_time_days: int,
      contact_email: optional,
      // PO-4 (ADR 032): optional column; blank keeps what was set in the app
      contact_phone: phone.optional(),
    }),
  },
  items: {
    file: '10_items.csv',
    required: false,
    schema: z.object({
      item_code: code,
      name: text,
      category: text,
      base_unit: text,
      is_perishable: yesNo,
      standard_unit_cost_inr: num.refine((v) => v >= 0, 'must not be negative'),
      preferred_supplier_code: optCode,
      // ADR 076: durable things (linen, equipment) are not stock that moves; blank: consumable
      item_type: z.union([
        z.literal('').transform(() => 'consumable' as const),
        z.enum(['consumable', 'durable'], 'must be consumable or durable'),
      ]),
      // ADR 080: where a delivery for a department goes by default; blank: into the store
      receive_to: z.union([
        z.literal('').transform(() => 'store' as const),
        z.enum(['store', 'department'], 'must be store or department'),
      ]),
    }),
    optional: ['item_type', 'receive_to'],
  },
  itemLocations: {
    file: '11_item_locations.csv',
    required: false,
    schema: z.object({
      item_code: code,
      store_node_code: code,
      par_level: num.refine((v) => v >= 0, 'must not be negative'),
      reorder_qty: num.refine((v) => v >= 0, 'must not be negative'),
      count_tolerance_pct: optNum.refine(
        (v) => v === undefined || (v >= 0 && v <= 100),
        'must be 0 to 100',
      ),
      preferred_supplier_code: optCode,
      // INV-7 (ADR 043): where the item sits in the store, for shelf-ordered count sheets;
      // optional columns, blank keeps what was set
      shelf: optional.refine((v) => v === undefined || v.length <= 60, 'at most 60 characters'),
      shelf_order: z.union([
        z.literal('').transform(() => undefined),
        int.refine((v) => v >= 0, 'must not be negative'),
      ]),
    }),
    optional: ['shelf', 'shelf_order'],
  },
  openingStock: {
    file: '12_opening_stock.csv',
    required: false,
    schema: z.object({
      item_code: code,
      store_node_code: code,
      quantity: num.refine((v) => v >= 0, 'must not be negative'),
      unit_cost_inr: num.refine((v) => v >= 0, 'must not be negative'),
      as_of_date: date,
    }),
  },
  leaveTypes: {
    file: '13_leave_types.csv',
    required: false,
    schema: z.object({
      leave_type_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an upper-case code'),
      name: text,
      annual_days: optNum,
      balance_tracked: yesNo,
    }),
  },
  leaveBalances: {
    file: '14_leave_balances.csv',
    required: false,
    schema: z.object({
      username: text,
      leave_type_code: text,
      year: int.refine((v) => v >= 2000 && v <= 2100, 'must be a year'),
      entitled_days: num.refine((v) => v >= 0, 'must not be negative'),
      used_days: num.refine((v) => v >= 0, 'must not be negative'),
    }),
  },
  rosterSettings: {
    file: '15_roster_settings.csv',
    required: false,
    schema: z.object({
      setting: z.enum([
        'min_rest_hours',
        'weekly_hours_cap',
        'late_threshold_min',
        'extra_time_min_minutes',
      ]),
      value: num,
      meaning: optional,
    }),
  },
  shiftTemplates: {
    file: '16_shift_templates.csv',
    required: false,
    schema: z.object({
      roster_node_code: code,
      shift_name: text,
      start_time: time,
      end_time: time,
      job_role_code: text,
      headcount: int.refine((v) => v >= 1 && v <= 50, 'must be 1 to 50'),
      days,
      // ADR 082: straight (one block), split (two blocks: start to first_end, second_start to
      // end) or panzer (the late or overnight shift, about 18:00-19:00 to 03:00-04:00)
      shift_type: z.union([
        z.literal('').transform(() => 'straight' as const),
        z.enum(['straight', 'split', 'panzer'], 'must be straight, split or panzer'),
      ]),
      first_end: z.union([z.literal('').transform(() => undefined), time]),
      second_start: z.union([z.literal('').transform(() => undefined), time]),
      // unpaid minutes inside the shift (a meal break), as well as a split's gap
      break_minutes: z.union([
        z.literal('').transform(() => 0),
        int.refine((v) => v >= 0 && v <= 240, 'must be 0 to 240'),
      ]),
    }),
    optional: ['shift_type', 'first_end', 'second_start', 'break_minutes'],
  },
  events: {
    file: '17_events_TEST_DATA_ONLY.csv',
    required: false,
    schema: z.object({
      org_node_code: code,
      event_name: text,
      starts_at: localDateTime,
      ends_at: localDateTime,
      covers: int,
      requirements,
    }),
  },
  // Menu, recipes and prep (MENU_README.md, ADR 014)
  unitConversions: {
    file: '18_item_unit_conversions.csv',
    required: false,
    schema: z.object({
      item_code: code,
      stock_unit: text,
      recipe_unit: recipeUnit,
      recipe_units_per_stock_unit: num.refine((v) => v > 0, 'must be more than 0'),
    }),
  },
  prepItems: {
    file: '19_prep_items.csv',
    required: false,
    schema: z.object({
      prep_item_code: code,
      name: text,
      prep_type: z.enum(
        ['kitchen_prep', 'house_mixer', 'batched_cocktail'],
        'must be kitchen_prep, house_mixer or batched_cocktail',
      ),
      unit: recipeUnit,
      batch_yield: num.refine((v) => v > 0, 'must be more than 0'),
      shelf_life_hours: int.refine((v) => v > 0, 'must be more than 0'),
      // ADR 076, for the batch label (FSSAI): veg or non-veg, allergens, portions a batch makes
      food_type: z.union([
        z.literal('').transform(() => undefined),
        z.enum(FOOD_TYPES, 'must be veg, non_veg or egg'),
      ]),
      allergens: z.string().transform((v, ctx) => {
        const r = parseAllergens(v);
        if ('ok' in r) return r.ok;
        ctx.addIssue({
          code: 'custom',
          message: `"${r.bad}" is not an allergen FSSAI lists (${ALLERGENS.join('; ')})`,
        });
        return z.NEVER;
      }),
      batch_portions: optNum.refine((v) => v === undefined || v > 0, 'must be more than 0'),
    }),
    optional: ['food_type', 'allergens', 'batch_portions'],
  },
  prepLocations: {
    file: '20_prep_locations.csv',
    required: false,
    schema: z.object({
      prep_item_code: code,
      store_node_code: code,
      made_here: yesNo,
      par_level: num.refine((v) => v >= 0, 'must not be negative'),
    }),
  },
  recipes: {
    file: '21_recipes.csv',
    required: false,
    schema: z.object({
      recipe_for_code: code,
      recipe_for_kind: z.enum(['prep', 'menu'], 'must be prep or menu'),
      ingredient_code: code,
      ingredient_kind: z.enum(['raw', 'prep'], 'must be raw or prep'),
      quantity: num.refine((v) => v > 0, 'must be more than 0'),
      unit: recipeUnit,
      trim_loss_pct: num.refine((v) => v >= 0 && v < 100, 'must be 0 to under 100'),
    }),
  },
  menuItems: {
    file: '22_menu_items.csv',
    required: false,
    schema: z.object({
      menu_item_code: code,
      name: text,
      menu: z.enum(['Food', 'Bar'], 'must be Food or Bar'),
      category: text,
      serving: text,
    }),
  },
  menuOutlets: {
    file: '23_menu_outlets.csv',
    required: false,
    schema: z.object({
      menu_item_code: code,
      outlet_code: code,
      sold_from_store_code: code,
      price_inr_before_tax: num.refine((v) => v >= 0, 'must not be negative'),
      // the item's code on the outlet's POS, for the POS import (ADR 039)
      pos_code: z.union([
        z.literal('').transform(() => undefined),
        z
          .string()
          .regex(/^[^\s]{1,40}$/, 'must be the POS item code, up to 40 characters, no spaces'),
      ]),
    }),
    optional: ['pos_code'],
  },
  prepProcedures: {
    file: '24_prep_procedures.csv',
    required: false,
    schema: z.object({
      // a prep item's code, or a dish's (file 22) when recipe_for_kind is menu (ADR 078)
      prep_item_code: code,
      recipe_for_kind: z.union([
        z.literal('').transform(() => 'prep' as const),
        z.enum(['prep', 'menu'], 'must be prep or menu'),
      ]),
      step: int.refine((v) => v >= 1, 'must be 1 or more'),
      instruction: text,
      minutes: optNum.refine((v) => v === undefined || v >= 0, 'must not be negative'),
    }),
    optional: ['recipe_for_kind'],
  },
  // Test-only activity (ADR 017): refused for a customer that isn't a test customer. Dates
  // are offsets from the load date, so the data is always recent.
  shifts: {
    file: '25_shifts_TEST_DATA_ONLY.csv',
    required: false,
    testOnly: true,
    schema: z.object({
      roster_node_code: code,
      shift_name: text,
      job_role_code: text,
      // 1 = the week starting next Monday, 2 = the week after
      week: int.refine((v) => v >= 1 && v <= 4, 'must be 1 to 4'),
      days,
      username: text,
      rostered_by: text,
    }),
  },
  production: {
    file: '26_production_TEST_DATA_ONLY.csv',
    required: false,
    testOnly: true,
    schema: z.object({
      store_node_code: code,
      prep_item_code: code,
      day: dayOffset,
      time,
      quantity: num.refine((v) => v > 0, 'must be more than 0'),
      made_by: text,
    }),
  },
  sales: {
    file: '27_sales_TEST_DATA_ONLY.csv',
    required: false,
    testOnly: true,
    schema: z.object({
      outlet_code: code,
      day: dayOffset,
      menu_item_code: code,
      quantity: num.refine((v) => v >= 0, 'must not be negative'),
      posted_by: text,
    }),
  },
  counts: {
    file: '28_counts_TEST_DATA_ONLY.csv',
    required: false,
    testOnly: true,
    schema: z.object({
      store_node_code: code,
      item_code: code,
      // counted minus what the system expects at the count; 0 = on target
      difference: num,
      counted_by: text,
      approved_by: text,
    }),
  },
  // Checklists (ADR 020): one row per step; the other columns repeat on every step row of
  // the same template_code.
  checklistTemplates: {
    file: '29_checklist_templates.csv',
    required: false,
    schema: z.object({
      template_code: code,
      place_code: code,
      name: text,
      schedule,
      assign_to: assignTo,
      step: int.refine((v) => v >= 1 && v <= 30, 'must be 1 to 30'),
      step_label: text,
      step_kind: z.enum(['tick', 'number', 'text', 'photo'], 'must be tick, number, text or photo'),
      min: optNum,
      max: optNum,
      unit: optional,
      photo_required: optYesNo,
      // ADR 079: optional, the step's picture (TASK_ICONS); blank: picked from its words
      step_icon: z
        .string()
        .default('')
        .transform((v, ctx) => {
          if (v === '') return undefined;
          if (isTaskIcon(v)) return v;
          ctx.addIssue({ code: 'custom', message: `must be one of ${TASK_ICONS.join(', ')}` });
          return z.NEVER;
        }),
      // ADR 062: optional, `CHILLER-LOG@1` for a copy of a library checklist
      from_library: z
        .string()
        .default('')
        .transform((v, ctx) => {
          if (v === '') return undefined;
          const m = /^([A-Z][A-Z0-9-]*)@([1-9]\d*)$/.exec(v);
          if (m) return { code: m[1]!, version: Number(m[2]) };
          ctx.addIssue({ code: 'custom', message: 'must be like CHILLER-LOG@1' });
          return z.NEVER;
        }),
      // ADR 087: optional, the weekdays the step runs (`Mon,Thu`, `Mon-Fri`); blank: every round
      days: z
        .string()
        .default('')
        .transform((v, ctx) => {
          if (v === '') return undefined;
          const r = days.safeParse(v);
          if (r.success) return r.data;
          ctx.addIssue({ code: 'custom', message: r.error.issues[0]!.message });
          return z.NEVER;
        }),
      // ADR 087: optional, the same on every row of a checklist: who signs it off once done.
      // Blank or `none`; `up` (the role one level up there, else the department head),
      // `department_head` or `role:CODE`
      sign_off: z
        .string()
        .default('')
        .transform((v, ctx) => {
          if (v === '' || v === 'none') return 'none';
          if (/^(up|department_head|role:[A-Z][A-Z0-9_]*)$/.test(v)) return v;
          ctx.addIssue({
            code: 'custom',
            message: 'must be blank, none, up, department_head or role:CODE',
          });
          return z.NEVER;
        }),
      // ADR 088: optional, the same on every row of a checklist: `rooms` (each room of its
      // outlet, file 40) or named areas `Lobby; Pool deck`; blank: once
      for_each: z
        .string()
        .default('')
        .transform((v, ctx) => {
          if (v === '') return undefined;
          if (v === 'rooms') return { rooms: true as const };
          const areas = v
            .split(';')
            .map((a) => a.trim())
            .filter(Boolean);
          if (
            areas.length >= 1 &&
            areas.length <= 60 &&
            areas.every((a) => a.length <= 60) &&
            new Set(areas.map((a) => a.toLowerCase())).size === areas.length
          ) {
            return { areas };
          }
          ctx.addIssue({
            code: 'custom',
            message: 'must be rooms, or 1 to 60 different areas separated by ";"',
          });
          return z.NEVER;
        }),
      // ADR 088: optional, what else a step asks: `food` (which food was probed, readings
      // only) and `thrown` (whether out-of-date food was thrown away), separated by ";"
      step_asks: z
        .string()
        .default('')
        .transform((v, ctx) => {
          const asks = v
            .split(';')
            .map((a) => a.trim())
            .filter(Boolean);
          if (asks.every((a) => a === 'food' || a === 'thrown')) {
            return { food: asks.includes('food'), thrown: asks.includes('thrown') };
          }
          ctx.addIssue({ code: 'custom', message: 'must be blank, food, thrown or food; thrown' });
          return z.NEVER;
        }),
    }),
    optional: ['step_icon', 'from_library', 'days', 'sign_off', 'for_each', 'step_asks'],
  },
  // Test-only tasks (ADR 020): one-off tasks, open maintenance requests and prep lists.
  tasks: {
    file: '30_tasks_TEST_DATA_ONLY.csv',
    required: false,
    testOnly: true,
    schema: z.object({
      place_code: code,
      title: text,
      description: optional,
      day: dayAround,
      due_time: time,
      priority: z.enum(['low', 'normal', 'high'], 'must be low, normal or high'),
      assign_to: assignTo,
      // tick steps, separated by ";"
      steps: optional,
      created_by: text,
      done_by: optional,
    }),
  },
  maintenance: {
    file: '31_maintenance_TEST_DATA_ONLY.csv',
    required: false,
    testOnly: true,
    schema: z.object({
      place_code: code,
      title: text,
      description: optional,
      reported_by: text,
      assigned_to: optional,
      assigned_by: optional,
    }),
  },
  prepTasks: {
    file: '32_prep_tasks_TEST_DATA_ONLY.csv',
    required: false,
    testOnly: true,
    schema: z.object({
      store_node_code: code,
      prep_item_code: code,
      day: dayOffset,
      due_time: time,
      quantity: num.refine((v) => v > 0, 'must be more than 0'),
      assign_to: assignTo,
      created_by: text,
    }),
  },
  // Test-only purchases (ADR 028): orders over the past days, approved, and received in
  // full, short or not at all. One row per order line; the order's columns repeat.
  purchases: {
    file: '33_purchases_TEST_DATA_ONLY.csv',
    required: false,
    testOnly: true,
    schema: z.object({
      order_ref: code,
      store_node_code: code,
      supplier_code: code,
      item_code: code,
      quantity: num.refine((v) => v > 0, 'must be more than 0'),
      unit_cost_inr: num.refine((v) => v >= 0, 'must not be negative'),
      ordered_day: dayOffset,
      ordered_by: text,
      approved_by: text,
      // blank: not delivered yet
      received_day: z.union([z.literal('').transform(() => undefined), dayOffset]),
      received_quantity: optNum.refine((v) => v === undefined || v >= 0, 'must not be negative'),
      received_by: optional,
    }),
  },
  // Pay (COMPENSATION, ADR 030): one rate per person, monthly or hourly, for labour cost.
  // Any customer; HR's file, so it can be handed over on its own.
  payRates: {
    file: '34_pay_rates.csv',
    required: false,
    schema: z.object({
      username: text,
      pay_basis: z.enum(['monthly', 'hourly'], 'must be monthly or hourly'),
      pay_rate_inr: num.refine((v) => v > 0, 'must be more than 0'),
    }),
  },
  // Test-only attendance (ADR 030): past sessions, for labour cost and the People report.
  attendance: {
    file: '35_attendance_TEST_DATA_ONLY.csv',
    required: false,
    testOnly: true,
    schema: z.object({
      username: text,
      day: dayOffset,
      clock_in: time,
      clock_out: time,
    }),
  },
  // Test-only transfers (ADR 030): from the central kitchen, dispatched and received (or
  // still on the road), one row per line.
  transfers: {
    file: '36_transfers_TEST_DATA_ONLY.csv',
    required: false,
    testOnly: true,
    schema: z.object({
      transfer_ref: code,
      from_store_code: code,
      to_store_code: code,
      item_code: code,
      requested_qty: num.refine((v) => v > 0, 'must be more than 0'),
      requested_day: dayOffset,
      requested_by: text,
      // blank: not dispatched yet
      dispatched_qty: optNum.refine((v) => v === undefined || v >= 0, 'must not be negative'),
      dispatched_day: z.union([z.literal('').transform(() => undefined), dayOffset]),
      dispatched_by: optional,
      // blank: still on the road
      received_qty: optNum.refine((v) => v === undefined || v >= 0, 'must not be negative'),
      received_day: z.union([z.literal('').transform(() => undefined), dayOffset]),
      received_by: optional,
    }),
  },
  // Who covers it (ADR 061): per outlet, a job role it doesn't have is covered by a role it
  // has, or not done there. Only the exceptions: a role not listed is one the outlet has.
  // Any customer; authoritative (a cover no longer listed is removed).
  roleCover: {
    file: '37_role_cover.csv',
    required: false,
    schema: z.object({
      outlet_code: code,
      job_role_code: code,
      mode: z.enum(['covered_by', 'not_done'], 'must be covered_by or not_done'),
      covered_by_role: optional,
    }),
  },
  // The licence register (ADR 069): each licence of an outlet, with its number, authority,
  // dates and the job role that renews it. Any customer; shows once Compliance is in the plan.
  // Keyed by place and name: a later load corrects a licence, never removes one.
  licences: {
    file: '38_licences.csv',
    required: false,
    schema: z.object({
      place_code: code,
      kind: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be a kind like FSSAI or OTHER'),
      name: text,
      number: optional,
      authority: optional,
      issued_on: optDate,
      expires_on: optDate,
      renewal_role: code,
    }),
  },
  // The compliance calendar (ADR 069): recurring statutory jobs of an outlet or a department,
  // every 1 to 36 months. `owner_role` answers for it (at the outlet); `doer_role`, if given,
  // does it at its place and gets the To do item (ADR 073). Keyed by place and name, like file
  // 38; `from_library` (`PEST-CONTROL@1`) marks a copy of the product library's job.
  complianceCalendar: {
    file: '39_compliance_calendar.csv',
    required: false,
    schema: z.object({
      place_code: code,
      name: text,
      every_months: z.coerce
        .number()
        .refine(
          (v) => [1, 2, 3, 4, 6, 12, 24, 36].includes(v),
          'must be 1, 2, 3, 4, 6, 12, 24 or 36',
        ),
      next_due: date,
      owner_role: code,
      doer_role: optCode,
      needs_proof: yesNo,
      from_library: z
        .string()
        .default('')
        .transform((v, ctx) => {
          if (v === '') return undefined;
          const m = /^([A-Z][A-Z0-9-]*)@([1-9]\d*)$/.exec(v);
          if (m) return { code: m[1]!, version: Number(m[2]) };
          ctx.addIssue({ code: 'custom', message: 'must be like PEST-CONTROL@1' });
          return z.NEVER;
        }),
    }),
    optional: ['doer_role', 'from_library'],
  },
  // The rooms' minibars (ADR 072). File 41: each minibar set of an outlet, one row per item,
  // with its par and the price charged to the guest, refilled from one store of the outlet.
  // Keyed by outlet and set name; a set's items are as the file lists them.
  minibarSets: {
    file: '41_minibar_sets.csv',
    required: false,
    schema: z.object({
      outlet_code: code,
      set_name: text,
      store_node_code: code,
      item_code: code,
      par: num.refine((v) => v > 0, 'must be more than 0'),
      price_inr: num.refine((v) => v >= 0, 'must not be negative'),
    }),
  },
  // File 40: a hotel's rooms, each with its minibar set (blank: no minibar). Keyed by outlet
  // and room number; a later load corrects a room and never removes one.
  rooms: {
    file: '40_rooms.csv',
    required: false,
    schema: z.object({
      outlet_code: code,
      room_number: z.string().regex(/^[A-Za-z0-9-]{1,20}$/, 'must be like 101 or G-02'),
      floor: optional,
      room_type: optional,
      minibar_set: optional,
    }),
  },
  // File 42 (test customers only): minibar checks of the past week, one row per item counted.
  minibarChecks: {
    file: '42_minibar_checks_TEST_DATA_ONLY.csv',
    required: false,
    testOnly: true,
    schema: z.object({
      outlet_code: code,
      room_number: text,
      day: dayOffset,
      time,
      item_code: code,
      left: num.refine((v) => v >= 0, 'must not be negative'),
      checked_by: text,
      // added to the guest's bill, by whom (blank: still to charge)
      charged_by: optional,
    }),
  },
} as const;

export type FileKey = keyof typeof FILES;
/** Files only a test customer may load (is_test in file 00). */
export const TEST_ONLY_FILES = (Object.keys(FILES) as FileKey[]).filter(
  (k) => 'testOnly' in FILES[k],
);
export type Row<K extends FileKey> = z.output<(typeof FILES)[K]['schema']> & { line: number };
export type Bundle = { [K in FileKey]: Row<K>[] };

/**
 * Parses the uploaded files (name -> content). A file is matched by its number prefix, so
 * `07_users.csv` and `07_users (1).csv` both count. Returns typed rows and every issue.
 */
export function readBundle(files: Record<string, string>): { bundle: Bundle; issues: Issue[] } {
  const issues: Issue[] = [];
  const bundle = {} as Record<FileKey, unknown[]>;
  for (const [key, spec] of Object.entries(FILES) as [FileKey, (typeof FILES)[FileKey]][]) {
    const prefix = spec.file.slice(0, 3);
    const name = Object.keys(files).find((f) => f.split('/').pop()!.startsWith(prefix));
    bundle[key] = [];
    if (name === undefined) {
      if (spec.required) issues.push({ file: spec.file, message: 'file is missing' });
      continue;
    }
    let table;
    try {
      table = parseCsv(files[name]!);
    } catch (e) {
      if (!(e instanceof CsvError)) throw e;
      issues.push({ file: spec.file, row: e.line, message: e.message });
      continue;
    }
    const optionalColumns: readonly string[] = 'optional' in spec ? spec.optional : [];
    const want = Object.keys(spec.schema.shape);
    const missing = want.filter((c) => !table.header.includes(c) && !optionalColumns.includes(c));
    for (const r of table.rows) {
      for (const c of optionalColumns) r.values[c] ??= '';
    }
    if (missing.length) {
      for (const column of missing) {
        issues.push({ file: spec.file, row: 1, column, message: 'column is missing' });
      }
      continue;
    }
    for (const r of table.rows) {
      const parsed = spec.schema.safeParse(r.values);
      if (parsed.success) {
        bundle[key].push({ ...parsed.data, line: r.line });
      } else {
        for (const i of parsed.error.issues) {
          issues.push({
            file: spec.file,
            row: r.line,
            column: String(i.path[0] ?? ''),
            message: i.message,
          });
        }
      }
    }
  }
  fillFromCatalogue(bundle as Bundle, issues);
  return { bundle: bundle as Bundle, issues };
}

/**
 * File 06 rows for catalogue roles (ADR 060): a blank title, department or access is taken
 * from the role catalogue; a value that is given is used as written. A blank `any` row also
 * brings the catalogue's rows for other outlet formats (the Bar Manager runs a standalone
 * bar) unless the file lists that format itself. A role that is not in the catalogue must be
 * filled in.
 */
function fillFromCatalogue(b: Bundle, issues: Issue[]): void {
  const file = FILES.jobRoles.file;
  const listed = new Set(b.jobRoles.map((r) => `${r.job_role_code} ${r.outlet_format}`));
  const extra: Bundle['jobRoles'] = [];
  for (const r of b.jobRoles) {
    const role = ROLE_BY_CODE.get(r.job_role_code);
    const blank = r.default_duties.length === 0 && r.default_access.length === 0;
    if (!role) {
      if (!r.job_title) {
        issues.push({
          file,
          row: r.line,
          column: 'job_title',
          message: `is required: ${r.job_role_code} is not a role in the catalogue`,
        });
      }
      continue;
    }
    const fmt = r.outlet_format === 'any' ? undefined : r.outlet_format;
    r.job_title ??= role.title;
    r.usual_department ??= (fmt && role.formatHome?.[fmt]) || role.home;
    if (!blank) continue;
    const duties = (fmt && role.formatDuties?.[fmt]) || role.duties;
    r.default_duties = dutyGrants(duties, (message) => {
      throw new Error(`role catalogue: ${role.code}: ${message}`);
    });
    if (r.outlet_format !== 'any') continue;
    for (const [format, list] of Object.entries(role.formatDuties ?? {})) {
      if (listed.has(`${role.code} ${format}`)) continue;
      extra.push({
        ...r,
        outlet_format: format as (typeof r)['outlet_format'],
        usual_department:
          role.formatHome?.[format as keyof typeof role.formatHome] ?? r.usual_department,
        default_duties: dutyGrants(list ?? [], (message) => {
          throw new Error(`role catalogue: ${role.code}: ${message}`);
        }),
        default_access: [],
      });
    }
  }
  b.jobRoles.push(...extra);
}

/** Everything a job role row grants: its duties' grants, then its direct grants (ADR 059). */
export function jobRoleAccess(r: {
  default_duties: AccessDefault[];
  default_access: AccessDefault[];
}): AccessDefault[] {
  return [...r.default_duties, ...r.default_access];
}
