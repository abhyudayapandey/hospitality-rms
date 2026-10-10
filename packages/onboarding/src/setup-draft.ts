import { z } from 'zod';
import {
  BUNDLES,
  BUNDLE_CODES,
  calendarFor,
  DEPARTMENTS,
  firstDue,
  licencesFor,
  DUTY_BY_CODE,
  EXTRAS,
  LEVELS,
  MODULES,
  ROLES,
  ROLE_BY_CODE,
  ACCESS_GROUPS,
  TILE_BY_CODE,
  bundlesFor,
  levelOf,
  type BundleCode,
  type ExtraCode,
  type Level,
} from '@outlet-ops/domain';
import { parseCsv, writeCsv } from './csv';
import {
  customerBundle,
  newCustomerFrom,
  ownerUsername,
  type CreatePayload,
} from './customer-files';
import { FILES } from './files';
import { addOutlet, planOutlet, TemplateError, type OutletPlan } from './outlet-template';

// The set-up wizard (ADR 064): a new customer on seven screens, saved as a draft at every
// Next. The draft is choices in plain words; this turns it into the customer's onboarding
// files (customerBundle, then addOutlet per outlet, then cover, people and stock), which the
// usual dry run checks like any import. Nothing here touches the database, and nothing the
// person types is a code: codes are made from names.

export const STEPS = [
  'company',
  'outlets',
  // what the customer buys (ADR 069): the bundles, right after the outlets
  'bundles',
  'departments',
  'roles',
  'people',
  'stock',
  'review',
] as const;
export type Step = (typeof STEPS)[number];
export const STEP_TITLE: Readonly<Record<Step, string>> = {
  company: 'Company',
  outlets: 'Outlets',
  bundles: 'What they buy',
  departments: 'Departments',
  roles: 'Roles',
  people: 'People',
  stock: 'Stock',
  review: 'Who does what',
};

export const UNITS = ['kg', 'g', 'l', 'ml', 'pcs'] as const;

const str = z.string().trim().max(200).default('');
const extraCodes = EXTRAS.map((e) => e.code) as [ExtraCode, ...ExtraCode[]];

const RoleAnswer = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('have') }),
  z.object({ mode: z.literal('covered_by'), by: z.string() }),
  z.object({ mode: z.literal('not_done') }),
]);
export type RoleAnswer = z.output<typeof RoleAnswer>;

const DraftOutlet = z.object({
  /** Stable within the draft; the outlet's code is made from its name at the end. */
  key: z.string(),
  tile: z.string(),
  extras: z.array(z.enum(extraCodes)).default([]),
  name: str,
  /** Optional: outlets with the same area name sit under one area. */
  area: str,
  /** "19.0596, 72.8295", pasted from a map; optional. */
  location: str,
  radius: str,
  /** The departments when changed from the template's; absent: the template's. */
  departments: z.array(z.string()).optional(),
  items: z.boolean().default(true),
  roles: z.record(z.string(), RoleAnswer).default({}),
  /** Starter items by `DEPT:ITEM`: left out, or a par. */
  stock: z.record(z.string(), z.object({ off: z.boolean().default(false), par: str })).default({}),
  /** The customer's own items, per department store. */
  ownItems: z
    .array(z.object({ department: z.string(), name: str, unit: z.enum(UNITS), par: str }))
    .default([]),
});
export type DraftOutlet = z.output<typeof DraftOutlet>;

const DraftPerson = z.object({
  name: str,
  email: str,
  /** A role code (picked from a list of titles). */
  role: z.string().default(''),
  /** An outlet key, or '' for the company (an HR Admin, an Area Manager). */
  outlet: z.string().default(''),
});
export type DraftPerson = z.output<typeof DraftPerson>;

export const SetupDraft = z.object({
  v: z.literal(1).default(1),
  company: z
    .object({
      name: str,
      /** The short name in logins (`acme.owner`); suggested from the name. */
      code: str,
      country: z.string().trim().default('India'),
      currency: z.string().trim().default('INR'),
      timezone: z.string().trim().default('Asia/Kolkata'),
      isTest: z.boolean().default(false),
      ownerName: str,
      ownerEmail: str,
      /** Which orders need approving (ADR 092): '' (unusual ones), `every`, `above:<amount>`. */
      purchaseApproval: z
        .string()
        .trim()
        .regex(/^(|every|above:\d+)$/)
        .catch('')
        .default(''),
    })
    .default({
      name: '',
      code: '',
      country: 'India',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      isTest: false,
      ownerName: '',
      ownerEmail: '',
      purchaseApproval: '',
    }),
  outlets: z.array(DraftOutlet).default([]),
  people: z.array(DraftPerson).default([]),
  /** Bundles the outlets use that the platform admin unticked (ADR 067). */
  bundlesOff: z.array(z.string()).default([]),
  /** Bundles the outlets don't usually use that the platform admin ticked (Compliance; ADR 069). */
  bundlesOn: z.array(z.string()).default([]),
});
export type SetupDraft = z.output<typeof SetupDraft>;

export const emptyDraft = (): SetupDraft => SetupDraft.parse({});

/** A saved draft; anything unreadable starts again from defaults rather than failing. */
export function readDraft(json: unknown): SetupDraft {
  const r = SetupDraft.safeParse(json ?? {});
  return r.success ? r.data : emptyDraft();
}

/** A problem with the draft, at the screen (and outlet or row) to fix it on. */
export interface DraftProblem {
  step: Step;
  outlet?: string;
  row?: number;
  message: string;
}

const words = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/** "Blue Tokai Coffee Roasters" → BLUE-TOKAI. */
export function customerCodeFrom(name: string): string {
  const w = words(name).map((x) => x.toUpperCase());
  const code = w.slice(0, 2).join('-').slice(0, 20).replace(/-+$/, '');
  return code.length >= 2 ? code : `${code}CO`.slice(0, 20);
}

/** The outlet codes, in order: `<CUSTOMER>-<NAME>`, numbered when two are alike. */
export function outletCodes(draft: SetupDraft): Map<string, string> {
  const cust = companyCode(draft);
  const out = new Map<string, string>();
  const taken = new Set<string>();
  const custWords = cust.split('-');
  for (const o of draft.outlets) {
    let w = words(o.name).map((x) => x.toUpperCase());
    // an outlet named like its company ("Test Cafe" of Test Cafe) is its main one, not
    // TEST-CAFE-TEST-CAFE; "Test Cafe Bandra" is TEST-CAFE-BANDRA
    const named = w.length > 0;
    if (w.slice(0, custWords.length).join('-') === cust) w = w.slice(custWords.length);
    const base = `${cust}-${
      w.join('-').slice(0, 24).replace(/-+$/, '') || (named ? 'MAIN' : 'OUTLET')
    }`;
    let code = base;
    for (let n = 2; taken.has(code); n++) code = `${base}-${n}`;
    taken.add(code);
    out.set(o.key, code);
  }
  return out;
}

export const companyCode = (draft: SetupDraft) =>
  (draft.company.code || customerCodeFrom(draft.company.name)).toUpperCase();

const areaCode = (cust: string, area: string) =>
  `${cust}-${words(area)
    .map((x) => x.toUpperCase())
    .join('-')
    .slice(0, 24)}-AREA`;

/** The create payload Go live sends: the same company and owner as the files. */
export function createPayload(draft: SetupDraft): CreatePayload {
  const c = draft.company;
  return {
    code: companyCode(draft),
    name: c.name,
    country: c.country,
    currency: c.currency,
    timezone: c.timezone,
    is_test: c.isTest,
    owner: { display_name: c.ownerName, email: c.ownerEmail.toLowerCase(), login_type: 'email' },
  };
}

/** The template plan of one outlet, as the draft has it. */
export function outletPlan(draft: SetupDraft, o: DraftOutlet): OutletPlan {
  return planOutlet({
    tile: o.tile,
    extras: o.extras,
    code: 'PLAN',
    name: o.name || 'Outlet',
    parentCode: 'PLAN',
    timezone: draft.company.timezone,
    ...(o.departments && { departments: o.departments }),
    items: o.items,
  });
}

/**
 * The bundles the draft's outlets use (ADR 067), each ticked unless the platform admin
 * unticked it. Go live puts the ticked ones in the customer's plan and leaves the rest out.
 */
export function draftBundles(draft: SetupDraft): {
  code: BundleCode;
  name: string;
  adds: string;
  uses: string[];
  /** its outlets use it: ticked unless unticked; the rest unticked unless ticked */
  usual: boolean;
  ticked: boolean;
}[] {
  const modules = new Set<string>();
  for (const o of draft.outlets) {
    try {
      for (const m of outletPlan(draft, o).modules) modules.add(m);
    } catch {
      // an outlet the review lists as a problem uses nothing yet
    }
  }
  const used = new Set(bundlesFor(modules).map((b) => b.code));
  return BUNDLES.map((b) => {
    const usual = used.has(b.code);
    return {
      code: b.code,
      name: b.name,
      adds: b.adds,
      uses: MODULES.filter(
        (m) => modules.has(m.code) && (b.modules as readonly string[]).includes(m.code),
      ).map((m) => m.name),
      usual,
      ticked: usual ? !draft.bundlesOff.includes(b.code) : draft.bundlesOn.includes(b.code),
    };
  });
}

/** Go live's plan: the bundles ticked on "What they buy", the rest out. */
export function planFromDraft(draft: SetupDraft): Record<BundleCode, boolean> {
  const on = new Set(
    draftBundles(draft)
      .filter((b) => b.ticked)
      .map((b) => b.code),
  );
  return Object.fromEntries(BUNDLE_CODES.map((b) => [b, on.has(b)])) as Record<BundleCode, boolean>;
}

const dutiesOf = (code: string, format: OutletPlan['format']): readonly string[] => {
  const r = ROLE_BY_CODE.get(code)!;
  return r.formatDuties?.[format] ?? r.duties;
};
const dutyName = (d: string) => {
  const def = DUTY_BY_CODE.get(d.split('@')[0]!);
  const at = d.split('@department:')[1];
  const dept = at ? DEPARTMENTS.find((x) => x.code === at)?.name : undefined;
  return def ? `${def.name[0]!.toLowerCase()}${def.name.slice(1)}${dept ? ` (${dept})` : ''}` : d;
};

export interface RoleQuestion {
  code: string;
  title: string;
  department: string;
  level: Level;
  /** What the role does, in plain words. */
  does: string[];
  answer: RoleAnswer;
}

/** Screen 4: every role the outlet's template expects, with the answer so far. */
export function roleQuestions(draft: SetupDraft, o: DraftOutlet): RoleQuestion[] {
  const plan = outletPlan(draft, o);
  return plan.roles.map((r) => {
    const duties = dutiesOf(r.code, plan.format);
    return {
      code: r.code,
      title: r.title,
      department: r.department,
      level: levelOf(duties),
      does: [...new Set(duties.map(dutyName))],
      answer: o.roles[r.code] ?? { mode: 'have' },
    };
  });
}

/** Plain-words lines for screen 4 and the review: what moves, and covers worth a look. */
export function coverLines(
  draft: SetupDraft,
  o: DraftOutlet,
): { role: string; line: string; warning?: string }[] {
  const qs = roleQuestions(draft, o);
  const by = new Map(qs.map((q) => [q.code, q]));
  const lines: { role: string; line: string; warning?: string }[] = [];
  for (const q of qs) {
    if (q.answer.mode === 'not_done') {
      lines.push({
        role: q.code,
        line: `Nobody here is a ${q.title}: its checklists don't run here; its approvals and alerts go to the manager above.`,
      });
    }
    if (q.answer.mode !== 'covered_by') continue;
    const c = by.get(q.answer.by);
    if (!c) continue;
    const line = `The ${c.title} also does the ${q.title}'s work: ${q.does.join(', ')}.`;
    // running a department or the outlet, covered by someone lower: worth a second look
    const warn =
      LEVELS.indexOf(q.level) >= LEVELS.indexOf('runs_department') &&
      LEVELS.indexOf(c.level) < LEVELS.indexOf(q.level);
    lines.push({
      role: q.code,
      line,
      ...(warn && {
        warning: `A ${c.title} usually works below a ${q.title}: check that is meant.`,
      }),
    });
  }
  return lines;
}

/** Everything a person must fix before Go live, with the screen to fix it on. */
export function draftProblems(draft: SetupDraft): DraftProblem[] {
  const out: DraftProblem[] = [];
  const c = draft.company;
  if (!c.name) out.push({ step: 'company', message: 'The company needs a name' });
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(companyCode(draft))) {
    out.push({
      step: 'company',
      message: 'The short name may use letters, digits and dashes only (2 to 20)',
    });
  }
  if (!c.ownerName) out.push({ step: 'company', message: "The owner's name is missing" });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.ownerEmail)) {
    out.push({ step: 'company', message: "The owner's email is missing or not an email" });
  }
  if (!draft.outlets.length) out.push({ step: 'outlets', message: 'Add at least one outlet' });
  for (const o of draft.outlets) {
    const label = o.name || 'An outlet';
    if (!TILE_BY_CODE.has(o.tile)) {
      out.push({ step: 'outlets', outlet: o.key, message: `${label}: pick what it is` });
      continue;
    }
    if (!o.name) out.push({ step: 'outlets', outlet: o.key, message: 'An outlet needs a name' });
    if (o.location && !parseLocation(o.location)) {
      out.push({
        step: 'outlets',
        outlet: o.key,
        message: `${label}: the location should look like 19.0596, 72.8295`,
      });
    }
    let plan: OutletPlan;
    try {
      plan = outletPlan(draft, o);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      out.push({ step: 'departments', outlet: o.key, message: `${label}: ${err.message}` });
      continue;
    }
    if (!plan.departments.length) {
      out.push({ step: 'departments', outlet: o.key, message: `${label} has no departments` });
    }
    const qs = roleQuestions(draft, o);
    const have = new Set(qs.filter((q) => q.answer.mode === 'have').map((q) => q.code));
    for (const q of qs) {
      if (q.answer.mode !== 'covered_by') continue;
      if (!have.has(q.answer.by)) {
        const who = ROLE_BY_CODE.get(q.answer.by)?.title ?? 'that role';
        out.push({
          step: 'roles',
          outlet: o.key,
          message: `${label}: the ${q.title} is covered by the ${who}, who isn't here`,
        });
      }
    }
    o.ownItems.forEach((i, n) => {
      if (!i.name) return;
      if (!plan.departments.some((d) => d.code === i.department && d.store)) {
        out.push({
          step: 'stock',
          outlet: o.key,
          row: n + 1,
          message: `${label}: ${i.name} is at a department without a store`,
        });
      }
      if (i.par && !(Number(i.par) >= 0)) {
        out.push({
          step: 'stock',
          outlet: o.key,
          row: n + 1,
          message: `${i.name}: par is a number`,
        });
      }
    });
    for (const [k, s] of Object.entries(o.stock)) {
      if (s.par && !(Number(s.par) >= 0)) {
        out.push({ step: 'stock', outlet: o.key, message: `${k.split(':')[1]}: par is a number` });
      }
    }
  }
  const keys = new Set(draft.outlets.map((o) => o.key));
  draft.people.forEach((p, n) => {
    const row = n + 1;
    if (!p.name) out.push({ step: 'people', row, message: `Row ${row}: the name is missing` });
    if (p.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) {
      out.push({ step: 'people', row, message: `Row ${row}: ${p.email} is not an email` });
    }
    const role = ROLE_BY_CODE.get(p.role);
    if (!role) {
      out.push({ step: 'people', row, message: `Row ${row}: pick a role for ${p.name}` });
      return;
    }
    if (p.outlet && !keys.has(p.outlet)) {
      out.push({ step: 'people', row, message: `Row ${row}: pick an outlet for ${p.name}` });
      return;
    }
    if (!p.outlet && !COMPANY_HOMES.includes(role.home)) {
      out.push({ step: 'people', row, message: `Row ${row}: pick an outlet for ${p.name}` });
    }
  });
  const emails = draft.people.map((p) => p.email.toLowerCase()).filter(Boolean);
  emails.push(c.ownerEmail.toLowerCase());
  const seen = new Set<string>();
  for (const e of emails) {
    if (seen.has(e)) out.push({ step: 'people', message: `${e} is given to two people` });
    seen.add(e);
  }
  return out;
}

const COMPANY_HOMES: readonly string[] = ['(company)', '(area)'];

/** Roles a person may hold at the company or an area, not at one outlet. */
export const COMPANY_ROLES = ROLES.filter(
  (r) => COMPANY_HOMES.includes(r.home) && r.code !== 'ACCOUNT_OWNER',
);

export function parseLocation(s: string): { lat: number; lng: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return null;
  const [lat, lng] = [Number(m[1]), Number(m[2])];
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** A login ID from a name: `acme.ravi`, numbered when taken. */
export function usernameFor(cust: string, name: string, taken: Set<string>): string {
  const first = words(name)
    .map((w) => w.toLowerCase())
    .slice(0, 2)
    .join('.');
  const base = `${cust.toLowerCase()}.${first || 'staff'}`;
  let u = base;
  for (let n = 2; taken.has(u); n++) u = `${base}.${n}`;
  taken.add(u);
  return u;
}

const itemCode = (name: string) =>
  words(name)
    .map((w) => w.toUpperCase())
    .join('-')
    .slice(0, 40) || 'ITEM';

/** The login each person gets: their email, or a login ID for the printed sheet. */
export function logins(draft: SetupDraft): { name: string; username: string; email: string }[] {
  const cust = companyCode(draft);
  const taken = new Set([ownerUsername(cust)]);
  return draft.people.map((p) => ({
    name: p.name,
    username: usernameFor(cust, p.name, taken),
    email: p.email.toLowerCase(),
  }));
}

function edit(files: Record<string, string>, key: keyof typeof FILES, header: string[]) {
  const prefix = FILES[key].file.slice(0, 3);
  const name = Object.keys(files).find((f) => f.startsWith(prefix)) ?? FILES[key].file;
  const parsed = files[name] ? parseCsv(files[name]) : { header: [], rows: [] };
  const t = {
    header: parsed.header,
    rows: parsed.rows.map<Record<string, string>>((r) => r.values),
  };
  for (const h of header) if (!t.header.includes(h)) t.header.push(h);
  const save = () => {
    files[name] = writeCsv(t.header, t.rows);
  };
  return Object.assign(t, { save });
}

/**
 * The customer's complete onboarding files from the draft. Throws a TemplateError for a
 * draft with problems (check draftProblems first; every screen shows them).
 */
export function filesFromDraft(
  draft: SetupDraft,
  today: string = new Date().toISOString().slice(0, 10),
): Record<string, string> {
  const problems = draftProblems(draft);
  if (problems.length) throw new TemplateError(problems[0]!.message);
  const cust = companyCode(draft);
  let files = customerBundle(newCustomerFrom(createPayload(draft)));
  const codes = outletCodes(draft);

  // areas, when outlets name one
  const org = edit(files, 'orgNodes', []);
  const areas = new Map<string, string>();
  for (const o of draft.outlets) {
    if (!o.area || areas.has(o.area.toLowerCase())) continue;
    const code = areaCode(cust, o.area);
    areas.set(o.area.toLowerCase(), code);
    org.rows.push({
      node_code: code,
      name: o.area,
      kind: 'area',
      parent_code: cust,
      timezone: draft.company.timezone,
    });
  }
  org.save();

  const plans = new Map<string, OutletPlan>();
  for (const o of draft.outlets) {
    const r = addOutlet(files, {
      tile: o.tile,
      extras: o.extras,
      code: codes.get(o.key)!,
      name: o.name,
      parentCode: o.area ? areas.get(o.area.toLowerCase())! : cust,
      timezone: draft.company.timezone,
      ...(o.departments && { departments: o.departments }),
      items: o.items,
    });
    files = r.files;
    plans.set(o.key, r.plan);
  }

  // where clock-in works
  const located = draft.outlets.filter((o) => parseLocation(o.location));
  if (located.length) {
    const loc = edit(files, 'locations', [
      'org_node_code',
      'latitude',
      'longitude',
      'geofence_radius_m',
    ]);
    for (const o of located) {
      const p = parseLocation(o.location)!;
      loc.rows.push({
        org_node_code: codes.get(o.key)!,
        latitude: String(p.lat),
        longitude: String(p.lng),
        geofence_radius_m: o.radius && Number(o.radius) >= 10 ? String(Number(o.radius)) : '150',
      });
    }
    loc.save();
  }

  // who covers it (ADR 061): only the exceptions
  const covers = draft.outlets.flatMap((o) =>
    Object.entries(o.roles)
      .filter(
        ([role, a]) => a.mode !== 'have' && plans.get(o.key)!.roles.some((r) => r.code === role),
      )
      .map(([role, a]) => ({
        outlet_code: codes.get(o.key)!,
        job_role_code: role,
        mode: a.mode,
        covered_by_role: a.mode === 'covered_by' ? a.by : '',
      })),
  );
  if (covers.length) {
    const cover = edit(files, 'roleCover', [
      'outlet_code',
      'job_role_code',
      'mode',
      'covered_by_role',
    ]);
    cover.rows.push(...covers);
    cover.save();
  }

  // what they buy (ADR 069, 085): no checklist rounds without Daily work; with Events &
  // compliance (every block in a bought bundle is on, Compliance included), each outlet's licences (to fill in) and its calendar jobs, which its manager
  // answers for and its kitchen head or chief engineer does (ADR 073), else the manager
  const plan = planFromDraft(draft);
  if (draft.company.purchaseApproval) {
    const c = edit(files, 'customer', ['purchase_approval']);
    for (const r of c.rows) r['purchase_approval'] = draft.company.purchaseApproval;
    c.save();
  }
  if (!plan.daily_work) {
    for (const f of Object.keys(files)) if (f.startsWith('29_')) delete files[f];
  }
  if (plan.events_compliance) {
    const lic = edit(files, 'licences', [
      'place_code',
      'kind',
      'name',
      'number',
      'authority',
      'issued_on',
      'expires_on',
      'renewal_role',
    ]);
    const cal = edit(files, 'complianceCalendar', [
      'place_code',
      'name',
      'every_months',
      'next_due',
      'owner_role',
      'doer_role',
      'needs_proof',
      'from_library',
    ]);
    for (const o of draft.outlets) {
      const code = codes.get(o.key)!;
      const outletPlanned = plans.get(o.key)!;
      const qs = roleQuestions(draft, o);
      const manager = qs.find((q) => q.level === 'runs_outlet') ?? qs[0];
      if (!manager) continue;
      const head = (dept: string) =>
        outletPlanned.departments.some((d) => d.code === dept)
          ? qs.find((q) => q.department === dept && q.level === 'runs_department')
          : undefined;
      for (const k of licencesFor(outletPlanned.format, o.extras)) {
        lic.rows.push({
          place_code: code,
          kind: k.code,
          name: k.name,
          number: '',
          authority: k.authority,
          issued_on: '',
          expires_on: '',
          renewal_role: manager.code,
        });
      }
      for (const j of calendarFor(outletPlanned.format, o.extras)) {
        const dept =
          j.owner === 'kitchen' ? 'KITCHEN' : j.owner === 'engineering' ? 'ENGINEERING' : '';
        // a head whose role is covered hands it to the role that covers it; one not done here
        // leaves it with the manager
        const h = dept ? head(dept) : undefined;
        const a = h?.answer;
        const covered = a?.mode === 'covered_by' ? qs.find((q) => q.code === a.by) : h;
        const doer = (covered && covered.answer.mode !== 'not_done' && covered) || manager;
        cal.rows.push({
          place_code: doer === manager || !dept ? code : `${code}-${dept}`,
          name: j.name,
          every_months: String(j.everyMonths),
          next_due: firstDue(j, today),
          owner_role: manager.code,
          doer_role: doer === manager ? '' : doer.code,
          needs_proof: j.needsProof ? 'yes' : 'no',
          from_library: `${j.code}@${j.version}`,
        });
      }
    }
    lic.save();
    cal.save();
  }

  // people: at their role's department at their outlet, else the outlet (or the company)
  const roles = edit(files, 'jobRoles', []);
  const listed = new Set(roles.rows.map((r) => r['job_role_code']));
  const users = edit(files, 'users', []);
  const ids = logins(draft);
  draft.people.forEach((p, n) => {
    const role = ROLE_BY_CODE.get(p.role)!;
    if (!listed.has(role.code)) {
      listed.add(role.code);
      roles.rows.push({ job_role_code: role.code, outlet_format: 'any' });
    }
    let home = cust;
    const o = draft.outlets.find((x) => x.key === p.outlet);
    if (o) {
      const code = codes.get(o.key)!;
      const at = plans.get(o.key)!.roles.find((r) => r.code === role.code)?.department;
      const dept = at && !at.startsWith('(') ? `${code}-${at}` : null;
      home =
        dept && plans.get(o.key)!.departments.some((d) => `${code}-${d.code}` === dept)
          ? dept
          : code;
    } else if (role.home === '(area)') {
      home = [...areas.values()][0] ?? cust;
    }
    users.rows.push({
      username: ids[n]!.username,
      display_name: p.name,
      job_role_code: role.code,
      home_node_code: home,
      login_type: p.email ? 'email' : 'username',
      email: p.email.toLowerCase(),
      employment_type: 'full_time',
      joined_on: '',
      password_mode: '',
    });
  });
  roles.save();
  users.save();

  // stock: starter items left out or given a par; the customer's own items
  const items = edit(files, 'items', [
    'item_code',
    'name',
    'category',
    'base_unit',
    'is_perishable',
    'standard_unit_cost_inr',
  ]);
  const placed = edit(files, 'itemLocations', [
    'item_code',
    'store_node_code',
    'par_level',
    'reorder_qty',
  ]);
  for (const o of draft.outlets) {
    const code = codes.get(o.key)!;
    const plan = plans.get(o.key)!;
    const storeOf = (dept: string) =>
      dept === 'STORES-TEAM' ? `${code}-MAIN-STORE` : `${code}-${dept}-STORE`;
    for (const [k, s] of Object.entries(o.stock)) {
      const [dept, item] = k.split(':');
      const at = placed.rows.findIndex(
        (r) => r['item_code'] === item && r['store_node_code'] === storeOf(dept!),
      );
      if (at < 0) continue;
      if (s.off) placed.rows.splice(at, 1);
      else if (s.par) placed.rows[at]!['par_level'] = String(Number(s.par));
    }
    const have = new Set(items.rows.map((r) => r['item_code']));
    for (const i of o.ownItems) {
      if (!i.name || !plan.departments.some((d) => d.code === i.department && d.store)) continue;
      const ic = itemCode(i.name);
      if (!have.has(ic)) {
        have.add(ic);
        items.rows.push({
          item_code: ic,
          name: i.name,
          category: 'Other',
          base_unit: i.unit,
          is_perishable: 'no',
          standard_unit_cost_inr: '0',
        });
      }
      const store = storeOf(i.department);
      if (placed.rows.some((r) => r['item_code'] === ic && r['store_node_code'] === store))
        continue;
      placed.rows.push({
        item_code: ic,
        store_node_code: store,
        par_level: i.par ? String(Number(i.par)) : '0',
        reorder_qty: '0',
      });
    }
  }
  // a starter item left out at every store is not added at all
  const used = new Set(placed.rows.map((r) => r['item_code']));
  items.rows = items.rows.filter((r) => used.has(r['item_code']));
  if (items.rows.length || Object.keys(files).some((f) => f.startsWith('10_'))) {
    items.save();
    placed.save();
  }
  return files;
}

/** The wizard screen a loader issue is fixed on (by its file). */
export function stepOfFile(file: string): Step {
  const n = Number(file.slice(0, 2));
  if (n === 0) return 'company';
  if (n >= 1 && n <= 4) return 'outlets';
  if (n === 6 || n === 37) return 'roles';
  if (n === 38 || n === 39) return 'bundles';
  if (n === 7) return 'people';
  if (n >= 10 && n <= 12) return 'stock';
  return 'review';
}

/** The review ("Who does what"): per outlet, each role, what it does and who does it. */
export function whoDoesWhat(draft: SetupDraft) {
  return draft.outlets.map((o) => {
    const qs = roleQuestions(draft, o);
    const title = new Map(qs.map((q) => [q.code, q.title]));
    return {
      key: o.key,
      name: o.name,
      roles: qs.map((q) => {
        const people = draft.people
          .filter((p) => p.outlet === o.key && p.role === q.code)
          .map((p) => p.name);
        const coverers =
          q.answer.mode === 'covered_by'
            ? draft.people
                .filter((p) => p.outlet === o.key && p.role === (q.answer as { by: string }).by)
                .map((p) => p.name)
            : [];
        return {
          code: q.code,
          title: q.title,
          does: q.does,
          who:
            q.answer.mode === 'not_done'
              ? 'Not done here'
              : q.answer.mode === 'covered_by'
                ? `The ${title.get(q.answer.by) ?? q.answer.by}${coverers.length ? ` (${coverers.join(', ')})` : ''}`
                : people.length
                  ? people.join(', ')
                  : 'Nobody added yet',
          nobody:
            q.answer.mode === 'have'
              ? people.length === 0
              : q.answer.mode === 'covered_by' && coverers.length === 0,
        };
      }),
    };
  });
}

const distance = (a: string, b: string) => {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length]!;
};
const norm = (s: string) => words(s).join(' ').toLowerCase();

/** A role from what a person typed: its title or another name the SOPs use for it. */
export function matchRole(
  text: string,
  roles: readonly { code: string; title: string }[],
): { code?: string; suggestion?: string } {
  const t = norm(text);
  if (!t) return {};
  const names = roles.flatMap((r) => [
    { code: r.code, title: r.title, name: norm(r.title) },
    ...(ROLE_BY_CODE.get(r.code)?.alsoCalled ?? []).map((a) => ({
      code: r.code,
      title: r.title,
      name: norm(a),
    })),
  ]);
  const exact = names.find((n) => n.name === t);
  if (exact) return { code: exact.code };
  const near = names.map((n) => ({ ...n, d: distance(n.name, t) })).sort((a, b) => a.d - b.d)[0];
  return near && near.d <= Math.max(2, Math.floor(t.length / 4)) ? { suggestion: near.title } : {};
}

/** The roles a person may be given: each outlet's, then the company's. */
export function roleChoices(draft: SetupDraft): { code: string; title: string }[] {
  const seen = new Map<string, string>();
  for (const o of draft.outlets) {
    try {
      for (const r of outletPlan(draft, o).roles) seen.set(r.code, r.title);
    } catch {
      // an outlet with problems offers nothing; its screen says why
    }
  }
  for (const r of COMPANY_ROLES) seen.set(r.code, r.title);
  return [...seen].map(([code, title]) => ({ code, title }));
}

/**
 * People pasted from a sheet: one a line, "name, email, role, outlet" (tabs or commas; the
 * email and outlet may be blank). What can't be matched is kept blank, with a note.
 */
export function peopleFromPaste(
  draft: SetupDraft,
  text: string,
): { people: DraftPerson[]; notes: string[] } {
  const roles = roleChoices(draft);
  const people: DraftPerson[] = [];
  const notes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split(line.includes('\t') ? '\t' : ',').map((c) => c.trim());
    const [name = '', second = '', third = '', fourth = ''] = cells;
    // the email column may be left out: "Ravi, Barista, Bandra Café"
    const hasEmail = second.includes('@') || (second === '' && cells.length >= 4);
    const [email, roleText, outletText] = hasEmail ? [second, third, fourth] : ['', second, third];
    if (/^name$/i.test(name)) continue; // a header row
    const role = matchRole(roleText, roles);
    const outlet = draft.outlets.find((o) => norm(o.name) === norm(outletText));
    const only = draft.outlets.length === 1 ? draft.outlets[0] : undefined;
    const row = people.length + draft.people.length + 1;
    if (!role.code && roleText) {
      notes.push(
        `Row ${row}: no role called ${roleText}${role.suggestion ? `: did you mean ${role.suggestion}?` : ''}`,
      );
    }
    if (outletText && !outlet) notes.push(`Row ${row}: no outlet called ${outletText}`);
    const companyRole = COMPANY_ROLES.some((r) => r.code === role.code);
    people.push({
      name,
      email,
      role: role.code ?? '',
      outlet: outlet?.key ?? (companyRole ? '' : (only?.key ?? '')),
    });
  }
  return { people, notes };
}

/**
 * The dry run's warnings in the wizard's words (ADR 064). The loader names places, roles,
 * people and access groups by code; whoever sets up a customer never sees one, so each is
 * replaced by its name from the files this draft makes, and advice about a file's own syntax
 * is left out. The same warning twice is said once.
 */
export function warningsInWords(draft: SetupDraft, messages: readonly string[]): string[] {
  const names = new Map<string, string>();
  for (const g of ACCESS_GROUPS) names.set(g.code, g.name);
  for (const r of ROLES) names.set(r.code, r.title);
  names.set(ownerUsername(companyCode(draft)), draft.company.ownerName || 'the owner');
  let files: Record<string, string> = {};
  try {
    files = filesFromDraft(draft);
  } catch {
    // a draft that can't make its files has problems listed above; codes stay as they are
  }
  const rows = (key: keyof typeof FILES) => {
    const prefix = FILES[key].file.slice(0, 3);
    const f = Object.keys(files).find((n) => n.startsWith(prefix));
    return f ? parseCsv(files[f]!).rows.map((r) => r.values) : [];
  };
  for (const r of rows('orgNodes')) if (r['name']) names.set(r['node_code']!, r['name']);
  for (const r of rows('deliveryNodes')) if (r['name']) names.set(r['node_code']!, r['name']);
  for (const r of rows('jobRoles'))
    if (r['job_title']) names.set(r['job_role_code']!, r['job_title']);
  for (const r of rows('users'))
    if (r['display_name']) names.set(r['username']!, r['display_name']);
  const word = (t: string) =>
    names.get(t) ??
    (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(t) && t.length > 2
      ? t.toLowerCase().replace(/_/g, ' ')
      : t);
  const inWords = (m: string) =>
    m
      .replace(/\s*\([A-Z][A-Z0-9_]+\)/g, '') // an error code in brackets
      .replace(/\s*\([a-z_]+(, [a-z_]+)*\)/g, '') // approval steps by code
      .replace(/\.?\s*Add "\(this store only\)".*$/, '')
      .replace(/[A-Za-z0-9][A-Za-z0-9._@-]*[A-Za-z0-9]/g, word);
  // "<who>: <process> at <places> has no approver but them: ..." is said once per person
  const alone = new Map<string, { processes: string[]; fails: boolean }>();
  const said = new Set<string>();
  for (const m of messages) {
    const a = /^([^:]+): (\S+) .* has no approver but them: (.*)$/.exec(m);
    if (a) {
      const e = alone.get(a[1]!) ?? { processes: [], fails: false };
      e.processes.push(word(a[2]!));
      e.fails ||= !a[3]!.includes('account owner');
      alone.set(a[1]!, e);
      continue;
    }
    said.add(inWords(m));
  }
  for (const [who, e] of alone) {
    const list =
      e.processes.length > 1
        ? `${e.processes.slice(0, -1).join(', ')} and ${e.processes.at(-1)}`
        : e.processes[0];
    said.add(
      `${word(who)}'s own ${list} requests have nobody above them to approve: ` +
        (e.fails
          ? 'they will be refused until someone above them is set up'
          : 'they go through at once, as the account owner'),
    );
  }
  return [...said];
}
