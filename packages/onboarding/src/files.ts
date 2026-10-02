import { z } from 'zod';
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
const num = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'must be a number')
  .transform(Number);
const optNum = z.union([z.literal('').transform(() => undefined), num]);
const int = z.string().regex(/^\d+$/, 'must be a whole number').transform(Number);
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

export const OUTLET_FORMATS = ['full_hotel', 'small_hotel', 'standalone_bar'] as const;
export const SCOPES = [
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
}

/** `OUTLET_MANAGER@whole_outlet; HUB_MANAGER@central_kitchen_store(this store only)` */
const defaultAccess = z.string().transform((v, ctx): AccessDefault[] => {
  const out: AccessDefault[] = [];
  for (const part of v
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m = /^([A-Z][A-Z_]*)@([a-z_]+|department:[A-Z0-9][A-Z0-9-]*)(\(this store only\))?$/.exec(
      part,
    );
    if (!m || !(m[2]!.startsWith('department:') || (SCOPES as readonly string[]).includes(m[2]!))) {
      ctx.addIssue({ code: 'custom', message: `"${part}" is not GROUP@scope` });
      continue;
    }
    out.push({ group: m[1]!, scope: m[2]!, includeDescendants: !m[3] });
  }
  if (out.length === 0) ctx.addIssue({ code: 'custom', message: 'is required' });
  return out;
});

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
      // optional: a test customer (ADR 012); only when the customer is created, never changed
      is_test: z.union([z.literal('').transform(() => undefined), yesNo]),
    }),
    optional: ['leave_hr_approval', 'is_test'],
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
      outlet_format: z.union([z.literal('').transform(() => undefined), z.enum(OUTLET_FORMATS)]),
    }),
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
  jobRoles: {
    file: '06_job_roles.csv',
    required: true,
    schema: z.object({
      job_role_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an upper-case code'),
      job_title: text,
      outlet_format: z.enum(['any', ...OUTLET_FORMATS]),
      usual_department: optional,
      default_access: defaultAccess,
    }),
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
    }),
  },
  extraAccess: {
    file: '08_role_assignments_extra.csv',
    required: false,
    schema: z.object({
      username: text,
      access_group: z.string().regex(/^[A-Z][A-Z_]*$/, 'must be an access group code'),
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
    }),
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
    }),
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
    }),
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
    }),
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
    }),
  },
  prepProcedures: {
    file: '24_prep_procedures.csv',
    required: false,
    schema: z.object({
      prep_item_code: code,
      step: int.refine((v) => v >= 1, 'must be 1 or more'),
      instruction: text,
      minutes: optNum.refine((v) => v === undefined || v >= 0, 'must not be negative'),
    }),
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
  return { bundle: bundle as Bundle, issues };
}
