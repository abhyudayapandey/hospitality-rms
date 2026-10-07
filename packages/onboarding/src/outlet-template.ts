import {
  CHECKLIST_BY_CODE,
  DEPARTMENTS,
  EXTRA_BY_CODE,
  ROLE_BY_CODE,
  TEMPLATE_BY_FORMAT,
  TILE_BY_CODE,
  inView,
  roleDepartment,
  type ExtraCode,
  type OutletTemplate,
  type StarterItem,
  type TemplateChecklist,
  type TemplateRole,
  type View,
} from '@outlet-ops/domain';
import { parseCsv, writeCsv } from './csv';
import { FILES } from './files';

// An outlet from a template (ADR 062): the sales or onboarding team picks a tile and ticks
// what else is there; this turns the choice into rows of the customer's onboarding files and
// merges them into the files the customer already has. The loader treats a customer's files as
// the whole truth (file 06 removes access no longer listed), so a new outlet is always added
// to the complete set, then dry run and applied as any import. Nothing here touches the
// database: every check the loader has still applies.

export interface OutletChoice {
  /** A tile code (`cafe`, `restaurant_bar`, …). */
  tile: string;
  /** "Anything else here?": extras ticked. */
  extras: readonly ExtraCode[];
  /** The outlet's place code (`MUM-CAFE-1`); its departments and stores are named from it. */
  code: string;
  name: string;
  /** The region, area or company it sits under (file 01). */
  parentCode: string;
  timezone: string;
  /** The departments, when the person changed the defaults; else the template's. */
  departments?: readonly string[];
  /** Starter items at its stores (default yes). */
  items?: boolean;
}

/** What a choice gives, in plain words: for the console's review and the tests. */
export interface OutletPlan {
  format: OutletTemplate['format'];
  view?: View;
  departments: { code: string; name: string; type: string; store?: string; note?: string }[];
  /** Departments the template offers that are off (shown unticked). */
  offered: { code: string; name: string; alsoIn?: View; note?: string }[];
  roles: { code: string; title: string; department: string }[];
  checklists: { code: string; name: string; department: string; version: number }[];
  items: StarterItem[];
  modules: string[];
  centralKitchen: boolean;
}

export class TemplateError extends Error {}

/** The plan for a choice, before it becomes files. */
export function planOutlet(choice: OutletChoice): OutletPlan {
  const tile = TILE_BY_CODE.get(choice.tile);
  if (!tile) throw new TemplateError(`"${choice.tile}" is not a kind of outlet`);
  const t = TEMPLATE_BY_FORMAT.get(tile.format)!;
  const view = tile.view;
  for (const x of choice.extras) {
    if (!tile.offers.includes(x)) {
      throw new TemplateError(
        `"${EXTRA_BY_CODE.get(x)?.name ?? x}" is not offered for ${tile.name}`,
      );
    }
  }
  const extras = choice.extras.map((x) => EXTRA_BY_CODE.get(x)!);
  // this view's departments first; the other view's follow, offered unticked ("Also in a
  // restaurant" for a café)
  const own = [
    ...t.departments.filter((d) => inView(d, view)),
    ...t.departments.filter((d) => !inView(d, view)),
  ];
  const fromExtras = extras.flatMap((e) => e.departments ?? []);
  const known = new Set([...own.map((d) => d.code), ...fromExtras]);
  // an extra's departments come with it (untick the extra to leave them out)
  const chosen = choice.departments
    ? new Set([...choice.departments, ...fromExtras])
    : new Set([
        ...own.filter((d) => d.on !== false && inView(d, view)).map((d) => d.code),
        ...fromExtras,
      ]);
  for (const d of chosen) {
    if (!known.has(d)) throw new TemplateError(`${d} is not a department of ${tile.name}`);
  }
  const deptDef = new Map(DEPARTMENTS.map((d) => [d.code, d]));
  const noteOf = new Map(t.departments.flatMap((d) => (d.note ? [[d.code, d.note]] : [])));
  const departments = [...known]
    .filter((d) => chosen.has(d))
    .map((code) => {
      const d = deptDef.get(code)!;
      const note = noteOf.get(code);
      return {
        code,
        name: d.name,
        type: d.type,
        ...(d.store && { store: d.store }),
        ...(note && { note }),
      };
    });
  const on = new Set(departments.map((d) => d.code));

  // A piece for the other view comes in with a department of that view that was ticked: a
  // café that ticks the dining room gets its captain, stewards and opening checklist.
  const viewOf = new Map(t.departments.map((d) => [d.code, d.view]));
  const wanted = (piece: { view?: View }, dept: string) =>
    inView(piece, view) || (on.has(dept) && viewOf.get(dept) === piece.view);

  const roles = new Map<string, OutletPlan['roles'][number]>();
  const addRole = (r: TemplateRole) => {
    const role = ROLE_BY_CODE.get(r.code)!;
    const at = roleDepartment(r, role, t.format);
    if (!wanted(r, at) || roles.has(r.code)) return;
    if (!at.startsWith('(') && !on.has(at)) return;
    // a duty given at another department (an F&B Manager runs the Bar and Banquets) needs it
    const duties = role.formatDuties?.[t.format] ?? role.duties;
    const needs = duties.flatMap((d) =>
      d.includes('@department:') ? [d.split('@department:')[1]!] : [],
    );
    if (needs.some((d) => !on.has(d))) return;
    roles.set(r.code, { code: r.code, title: role.title, department: at });
  };
  t.roles.forEach(addRole);
  extras.filter((e) => !e.site).forEach((e) => (e.roles ?? []).forEach(addRole));

  const checklists = new Map<string, OutletPlan['checklists'][number]>();
  const addChecklist = (c: TemplateChecklist) => {
    const lib = CHECKLIST_BY_CODE.get(c.code)!;
    const at = c.department ?? lib.department;
    if (!wanted(c, at) || !on.has(at) || checklists.has(c.code)) return;
    checklists.set(c.code, { code: c.code, name: lib.name, department: at, version: lib.version });
  };
  t.checklists.forEach(addChecklist);
  extras.forEach((e) => (e.checklists ?? []).forEach(addChecklist));

  const items =
    choice.items === false
      ? []
      : [...t.items, ...extras.flatMap((e) => e.items ?? [])].filter(
          (i, n, all) =>
            wanted(i, i.department) &&
            on.has(i.department) &&
            all.findIndex((x) => x.code === i.code) === n,
        );

  return {
    format: t.format,
    ...(view && { view }),
    departments,
    offered: own
      .filter((d) => !on.has(d.code))
      .map((d) => ({
        code: d.code,
        name: deptDef.get(d.code)!.name,
        ...(d.view && view && d.view !== view && { alsoIn: d.view }),
        ...(d.note && { note: d.note }),
      })),
    roles: [...roles.values()],
    checklists: [...checklists.values()],
    items,
    modules: [...new Set([...t.modules, ...extras.flatMap((e) => e.modules ?? [])])],
    centralKitchen: extras.some((e) => e.site),
  };
}

type Rows = Record<string, string>[];

/** A department's place code at an outlet: `<OUTLET>-KITCHEN`. */
const deptCode = (outlet: string, dept: string) => `${outlet}-${dept}`;
/** The store a department keeps: the Main Store for Stores, else `<OUTLET>-<DEPT>-STORE`. */
const storeCode = (outlet: string, dept: string) =>
  dept === 'STORES-TEAM' ? `${outlet}-MAIN-STORE` : `${outlet}-${dept}-STORE`;

/**
 * The customer's files with the outlet added. `files` is their complete current set (the
 * last import, or the files the customer was created with). Codes already in use are refused
 * in plain words; nothing already in the files is changed (modules included: ADR 067).
 */
export function addOutlet(
  files: Record<string, string>,
  choice: OutletChoice,
): { files: Record<string, string>; plan: OutletPlan } {
  const plan = planOutlet(choice);
  const code = choice.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]*$/.test(code)) {
    throw new TemplateError('The outlet code may use letters, digits, dots and dashes only');
  }
  const tables = new Map<string, { name: string; header: string[]; rows: Rows }>();
  const table = (key: keyof typeof FILES, header: string[]) => {
    const file = FILES[key].file;
    const prefix = file.slice(0, 3);
    const name = Object.keys(files).find((f) => f.split('/').pop()!.startsWith(prefix)) ?? file;
    let t = tables.get(name);
    if (!t) {
      const text = files[name];
      const parsed = text ? parseCsv(text) : { header: [], rows: [] };
      t = { name, header: parsed.header, rows: parsed.rows.map((r) => r.values) };
      tables.set(name, t);
    }
    for (const h of header) if (!t.header.includes(h)) t.header.push(h);
    return t;
  };

  const customer = table('customer', []).rows[0];
  if (!customer) throw new TemplateError('The customer has no file 00 yet');
  const org = table('orgNodes', [
    'node_code',
    'name',
    'kind',
    'parent_code',
    'timezone',
    'outlet_format',
    'department_type',
  ]);
  const dlv = table('deliveryNodes', [
    'node_code',
    'name',
    'kind',
    'parent_code',
    'timezone',
    'holds_stock',
    'is_main_store',
  ]);
  const links = table('nodeLinks', ['org_node_code', 'delivery_node_code', 'note']);
  const taken = new Set([...org.rows, ...dlv.rows].map((r) => r['node_code']));
  if (!org.rows.some((r) => r['node_code'] === choice.parentCode)) {
    throw new TemplateError(`${choice.parentCode} is not a place of this customer`);
  }
  const tz = choice.timezone;
  const addOrg = (row: Record<string, string>) => {
    if (taken.has(row['node_code'])) {
      throw new TemplateError(
        `The code ${row['node_code']} is already used: pick another outlet code`,
      );
    }
    taken.add(row['node_code']);
    org.rows.push(row);
  };
  const addDlv = (row: Record<string, string>) => {
    if (taken.has(row['node_code'])) {
      throw new TemplateError(
        `The code ${row['node_code']} is already used: pick another outlet code`,
      );
    }
    taken.add(row['node_code']);
    dlv.rows.push(row);
  };

  // the supply network: the customer's own, or a new one for their first outlet
  let network = dlv.rows.find((r) => r['kind'] === 'network' && !r['parent_code'])?.['node_code'];
  if (!network) {
    network = `${customer['customer_code']!.toUpperCase()}-SUPPLY-NETWORK`;
    addDlv({
      node_code: network,
      name: `${customer['company_name']} – Supply Network`,
      kind: 'network',
      holds_stock: 'no',
      is_main_store: 'no',
    });
  }

  let supplyParent = network;
  if (plan.centralKitchen) {
    const site = `${code}-CK`;
    const hub = `${code}-CK-STORE`;
    addOrg({
      node_code: site,
      name: `${choice.name} – Central Kitchen`,
      kind: 'site',
      parent_code: choice.parentCode,
      timezone: tz,
    });
    for (const d of ['CENTRAL-KITCHEN-PRODUCTION', 'CENTRAL-KITCHEN-DISPATCH-TEAM']) {
      const def = DEPARTMENTS.find((x) => x.code === d)!;
      addOrg({
        node_code: `${site}-${d.replace('CENTRAL-KITCHEN-', '')}`,
        name: `${choice.name} Central Kitchen – ${def.name}`,
        kind: 'department',
        parent_code: site,
        timezone: tz,
        department_type: def.type,
      });
    }
    addDlv({
      node_code: hub,
      name: `${choice.name} – Central Kitchen Store`,
      kind: 'hub',
      parent_code: network,
      timezone: tz,
      holds_stock: 'yes',
      is_main_store: 'no',
    });
    links.rows.push(
      { org_node_code: site, delivery_node_code: hub, note: 'Central kitchen uses its store' },
      {
        org_node_code: `${site}-DISPATCH-TEAM`,
        delivery_node_code: hub,
        note: 'Dispatch runs the central kitchen store',
      },
      {
        org_node_code: `${site}-PRODUCTION`,
        delivery_node_code: hub,
        note: 'Production makes in the central kitchen store',
      },
    );
    supplyParent = hub;
  }

  // the outlet, its departments, its supply point and stores
  addOrg({
    node_code: code,
    name: choice.name,
    kind: 'outlet',
    parent_code: choice.parentCode,
    timezone: tz,
    outlet_format: plan.format,
  });
  const stores = plan.departments.filter((d) => d.store);
  const supply = `${code}-SUPPLY`;
  addDlv({
    node_code: supply,
    name: `${choice.name} – Supply Point`,
    kind: 'outlet',
    parent_code: supplyParent,
    timezone: tz,
    holds_stock: stores.length ? 'no' : 'yes',
    is_main_store: 'no',
  });
  links.rows.push({
    org_node_code: code,
    delivery_node_code: supply,
    note: `${choice.name} ↔ its supply point`,
  });
  for (const d of plan.departments) {
    addOrg({
      node_code: deptCode(code, d.code),
      name: `${choice.name} – ${d.name}`,
      kind: 'department',
      parent_code: code,
      timezone: tz,
      department_type: d.type,
    });
    if (!d.store) continue;
    addDlv({
      node_code: storeCode(code, d.code),
      name: `${choice.name} – ${d.store}`,
      kind: 'store',
      parent_code: supply,
      timezone: tz,
      holds_stock: 'yes',
      is_main_store: d.code === 'STORES-TEAM' ? 'yes' : 'no',
    });
    links.rows.push({
      org_node_code: deptCode(code, d.code),
      delivery_node_code: storeCode(code, d.code),
      note: `${d.name} keeps the ${d.store}`,
    });
  }

  // with no Main Store, a department without a store of its own uses the kitchen's (a QSR's
  // counter, a café's counter), else the first store; with one, it uses the Main Store
  if (stores.length && !plan.departments.some((d) => d.code === 'STORES-TEAM')) {
    const shared = stores.find((d) => d.code === 'KITCHEN') ?? stores[0]!;
    for (const d of plan.departments.filter((x) => !x.store)) {
      links.rows.push({
        org_node_code: deptCode(code, d.code),
        delivery_node_code: storeCode(code, shared.code),
        note: `${d.name} uses the ${shared.store}`,
      });
    }
  }

  // roles by catalogue code alone (ADR 060), where the customer doesn't list them already
  const jobRoles = table('jobRoles', [
    'job_role_code',
    'job_title',
    'outlet_format',
    'usual_department',
    'default_duties',
  ]);
  const listed = new Set(jobRoles.rows.map((r) => r['job_role_code']));
  const roleCodes = [...plan.roles.map((r) => r.code)];
  if (plan.centralKitchen) {
    roleCodes.push(...(EXTRA_BY_CODE.get('central_kitchen')!.roles ?? []).map((r) => r.code));
  }
  for (const r of roleCodes) {
    if (listed.has(r)) continue;
    listed.add(r);
    jobRoles.rows.push({ job_role_code: r, outlet_format: 'any' });
  }

  // starter checklists, copied from the library, to whoever is on shift
  if (plan.checklists.length) {
    const lists = table('checklistTemplates', [
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
    ]);
    for (const c of plan.checklists) {
      const lib = CHECKLIST_BY_CODE.get(c.code)!;
      lib.steps.forEach((s, i) =>
        lists.rows.push({
          template_code: `${code}-${c.code}`,
          place_code: deptCode(code, c.department),
          name: lib.name,
          schedule: lib.schedule,
          assign_to: 'on_shift',
          step: String(i + 1),
          step_label: s.label,
          step_kind: s.kind,
          min: s.min === undefined ? '' : String(s.min),
          max: s.max === undefined ? '' : String(s.max),
          unit: s.unit ?? '',
          photo_required: s.photo ? 'yes' : 'no',
          from_library: `${lib.code}@${lib.version}`,
        }),
      );
    }
  }

  // starter items at the stores that keep them; the customer adds par and prices
  if (plan.items.length) {
    const items = table('items', [
      'item_code',
      'name',
      'category',
      'base_unit',
      'is_perishable',
      'standard_unit_cost_inr',
      'preferred_supplier_code',
    ]);
    const placed = table('itemLocations', [
      'item_code',
      'store_node_code',
      'par_level',
      'reorder_qty',
      'count_tolerance_pct',
      'preferred_supplier_code',
    ]);
    const have = new Set(items.rows.map((r) => r['item_code']));
    for (const i of plan.items) {
      const dept = plan.departments.find((d) => d.code === i.department);
      if (!dept?.store) continue;
      if (!have.has(i.code)) {
        have.add(i.code);
        items.rows.push({
          item_code: i.code,
          name: i.name,
          category: i.category,
          base_unit: i.unit,
          is_perishable: i.perishable ? 'yes' : 'no',
          standard_unit_cost_inr: '0',
        });
      }
      placed.rows.push({
        item_code: i.code,
        store_node_code: storeCode(code, dept.code),
        par_level: '0',
        reorder_qty: '0',
      });
    }
  }

  // modules are never switched on here: what is on is the customer's plan (ADR 067), and the
  // console and the dry run say when the outlet uses a bundle that isn't in it

  const out = { ...files };
  for (const t of tables.values()) out[t.name] = writeCsv(t.header, t.rows);
  return { files: out, plan };
}
