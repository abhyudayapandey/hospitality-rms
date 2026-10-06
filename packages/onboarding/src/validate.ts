import { ACCESS_GROUPS, DOMAINS } from '@outlet-ops/domain';
import type { AssignTo, Bundle, Issue } from './files';
import { FILES, jobRoleAccess } from './files';

// Checks across files: every code refers to something that exists, the trees have the
// allowed shape, stock only sits where stock is held, and access uses product groups.
// What needs the database (resolving job-role scopes) is checked by the plan step.

const ORG_PARENTS: Record<string, string[]> = {
  company: [],
  region: ['company', 'region'],
  area: ['company', 'region', 'area'],
  outlet: ['company', 'region', 'area'],
  site: ['company', 'region', 'area'],
  department: ['outlet', 'site'],
};
const DELIVERY_PARENTS: Record<string, string[]> = {
  network: [],
  hub: ['network', 'hub'],
  outlet: ['network', 'hub'],
  store: ['outlet', 'hub'],
};
/** Groups a customer may hand out; AI_AGENT belongs to the service user only. */
const ASSIGNABLE = new Set(ACCESS_GROUPS.map((g) => g.code).filter((c) => c !== 'AI_AGENT'));

export function validateBundle(b: Bundle): Issue[] {
  const issues: Issue[] = [];
  const add = (file: string, row: number, column: string, message: string) =>
    issues.push({ file, row, column, message });
  const f = (k: keyof typeof FILES) => FILES[k].file;

  if (b.customer.length !== 1) {
    issues.push({ file: f('customer'), message: 'must have exactly one row' });
  }

  // structure: unique codes across both trees, parents of an allowed kind, no cycles
  const org = new Map(b.orgNodes.map((n) => [n.node_code, n]));
  const dlv = new Map(b.deliveryNodes.map((n) => [n.node_code, n]));
  const seen = new Map<string, string>();
  for (const [file, rows] of [
    [f('orgNodes'), b.orgNodes],
    [f('deliveryNodes'), b.deliveryNodes],
  ] as const) {
    for (const n of rows) {
      if (seen.has(n.node_code)) {
        add(
          file,
          n.line,
          'node_code',
          `${n.node_code} is already used in ${seen.get(n.node_code)}`,
        );
      }
      seen.set(n.node_code, `${file} line ${n.line}`);
    }
  }
  const checkTree = <
    N extends { line: number; node_code: string; kind: string; parent_code?: string | undefined },
  >(
    file: string,
    nodes: Map<string, N>,
    parents: Record<string, string[]>,
  ) => {
    for (const n of nodes.values()) {
      const allowed = parents[n.kind]!;
      if (!n.parent_code) {
        if (allowed.length) add(file, n.line, 'parent_code', `a ${n.kind} needs a parent`);
        continue;
      }
      const p = nodes.get(n.parent_code);
      if (!p) add(file, n.line, 'parent_code', `${n.parent_code} is not in this file`);
      else if (!allowed.includes(p.kind)) {
        add(file, n.line, 'parent_code', `a ${n.kind} cannot sit under a ${p.kind}`);
      }
    }
    for (const n of nodes.values()) {
      const path = new Set<string>();
      for (let c: N | undefined = n; c?.parent_code; c = nodes.get(c.parent_code)) {
        if (path.has(c.node_code)) {
          add(file, n.line, 'parent_code', 'the parents form a loop');
          break;
        }
        path.add(c.node_code);
      }
    }
    if ([...nodes.values()].filter((n) => !n.parent_code).length > 1) {
      issues.push({ file, message: 'must have exactly one top node' });
    }
  };
  checkTree(f('orgNodes'), org, ORG_PARENTS);
  checkTree(f('deliveryNodes'), dlv, DELIVERY_PARENTS);
  for (const n of b.orgNodes) {
    if (n.kind === 'outlet' && !n.outlet_format) {
      add(f('orgNodes'), n.line, 'outlet_format', 'is required on an outlet');
    }
    if (n.kind !== 'outlet' && n.outlet_format) {
      add(f('orgNodes'), n.line, 'outlet_format', 'is only for outlets');
    }
    if (n.kind !== 'department' && n.department_type) {
      add(f('orgNodes'), n.line, 'department_type', 'is only for departments');
    }
  }
  const mains = new Map<string, number>();
  for (const n of b.deliveryNodes) {
    if (n.is_main_store && n.kind !== 'store') {
      add(f('deliveryNodes'), n.line, 'is_main_store', 'only a store can be the main store');
    }
    if (n.is_main_store && !n.holds_stock) {
      add(f('deliveryNodes'), n.line, 'holds_stock', 'the main store must hold stock');
    }
    if (n.is_main_store && n.parent_code) {
      if (mains.has(n.parent_code)) {
        add(
          f('deliveryNodes'),
          n.line,
          'is_main_store',
          `${n.parent_code} already has a main store`,
        );
      }
      mains.set(n.parent_code, n.line);
    }
    if (n.kind === 'store' && !n.holds_stock) {
      add(f('deliveryNodes'), n.line, 'holds_stock', 'a store holds stock');
    }
  }

  // links: org -> delivery, at most one supply point per outlet or site
  const supplyOf = new Map<string, string>();
  for (const l of b.nodeLinks) {
    const o = org.get(l.org_node_code);
    const d = dlv.get(l.delivery_node_code);
    if (!o)
      add(f('nodeLinks'), l.line, 'org_node_code', `${l.org_node_code} is not in ${f('orgNodes')}`);
    if (!d) {
      add(
        f('nodeLinks'),
        l.line,
        'delivery_node_code',
        `${l.delivery_node_code} is not in ${f('deliveryNodes')}`,
      );
    }
    if (o && d && (o.kind === 'outlet' || o.kind === 'site')) {
      if (supplyOf.has(o.node_code)) {
        add(f('nodeLinks'), l.line, 'org_node_code', `${o.node_code} already has a supply point`);
      }
      supplyOf.set(o.node_code, d.node_code);
    }
  }

  for (const s of b.locations) {
    if (!org.has(s.org_node_code)) {
      add(f('locations'), s.line, 'org_node_code', `${s.org_node_code} is not in ${f('orgNodes')}`);
    }
  }

  // the customer's own groups (file 05, ADR 027): business rights only; the duties of
  // business roles only; never a product group's code
  const custom = new Set<string>();
  const businessDomains = new Set(DOMAINS.filter((d) => !d.admin).map((d) => d.code));
  const carriable = new Set(
    ACCESS_GROUPS.filter(
      (g) => g.kind === 'role' && !['AI_AGENT', 'SECURITY_ADMIN', 'AUDITOR'].includes(g.code),
    ).map((g) => g.code),
  );
  for (const g of b.customGroups) {
    if (ACCESS_GROUPS.some((p) => p.code === g.group_code)) {
      add(f('customGroups'), g.line, 'group_code', `${g.group_code} is a product access group`);
    }
    if (custom.has(g.group_code)) {
      add(f('customGroups'), g.line, 'group_code', `${g.group_code} is listed twice`);
    }
    custom.add(g.group_code);
    for (const d of Object.keys(g.rights)) {
      if (!businessDomains.has(d)) {
        add(f('customGroups'), g.line, 'rights', `${d} is not a business right`);
      }
    }
    for (const r of g.acts_as) {
      if (!carriable.has(r)) {
        add(f('customGroups'), g.line, 'acts_as', `${r} is not a business role`);
      }
    }
    if (Object.keys(g.rights).length === 0 && g.acts_as.length === 0) {
      add(f('customGroups'), g.line, 'rights', 'a group needs at least one right or role');
    }
  }
  const assignable = (code: string) => ASSIGNABLE.has(code) || custom.has(code);

  // job roles: access groups only, one row per role and format, an `any` row per role
  const roles = new Map<string, Set<string>>();
  for (const r of b.jobRoles) {
    const formats = roles.get(r.job_role_code) ?? new Set();
    if (formats.has(r.outlet_format)) {
      add(
        f('jobRoles'),
        r.line,
        'outlet_format',
        `${r.job_role_code} already has a ${r.outlet_format} row`,
      );
    }
    formats.add(r.outlet_format);
    roles.set(r.job_role_code, formats);
    for (const a of r.default_access) {
      if (!assignable(a.group)) {
        add(f('jobRoles'), r.line, 'default_access', `${a.group} is not an access group`);
      }
    }
    // duties and direct grants together (ADR 059): at least one, no grant twice
    const all = jobRoleAccess(r);
    if (all.length === 0) {
      add(f('jobRoles'), r.line, 'default_duties', 'needs default_duties or default_access');
    }
    const given = new Map<string, string>();
    for (const a of all) {
      const k = `${a.group}@${a.scope}`;
      const first = given.get(k);
      if (first !== undefined) {
        add(
          f('jobRoles'),
          r.line,
          a.duty ? 'default_duties' : 'default_access',
          `${k} is given twice (already by ${first})`,
        );
        continue;
      }
      given.set(k, a.duty ?? 'default_access');
    }
  }

  // users
  const users = new Map<string, (typeof b.users)[number]>();
  for (const u of b.users) {
    if (users.has(u.username)) add(f('users'), u.line, 'username', `${u.username} is listed twice`);
    users.set(u.username, u);
    if (!roles.has(u.job_role_code)) {
      add(f('users'), u.line, 'job_role_code', `${u.job_role_code} is not in ${f('jobRoles')}`);
    }
    if (!org.has(u.home_node_code)) {
      add(f('users'), u.line, 'home_node_code', `${u.home_node_code} is not in ${f('orgNodes')}`);
    }
    if (u.login_type === 'email' && !u.email) {
      add(f('users'), u.line, 'email', 'is required when login_type is email');
    }
  }
  for (const e of b.extraAccess) {
    if (!users.has(e.username)) {
      add(f('extraAccess'), e.line, 'username', `${e.username} is not in ${f('users')}`);
    }
    if (!assignable(e.access_group)) {
      add(f('extraAccess'), e.line, 'access_group', `${e.access_group} is not an access group`);
    }
    if (!org.has(e.node_code) && !dlv.has(e.node_code)) {
      add(f('extraAccess'), e.line, 'node_code', `${e.node_code} is not a place in this customer`);
    }
  }

  // stock
  const suppliers = new Set<string>();
  for (const s of b.suppliers) {
    if (suppliers.has(s.supplier_code)) {
      add(f('suppliers'), s.line, 'supplier_code', `${s.supplier_code} is listed twice`);
    }
    suppliers.add(s.supplier_code);
  }
  const supplierRef = (file: string, line: number, column: string, code?: string) => {
    if (code && !suppliers.has(code))
      add(file, line, column, `${code} is not in ${f('suppliers')}`);
  };
  const items = new Map<string, (typeof b.items)[number]>();
  for (const i of b.items) {
    if (items.has(i.item_code))
      add(f('items'), i.line, 'item_code', `${i.item_code} is listed twice`);
    items.set(i.item_code, i);
    supplierRef(f('items'), i.line, 'preferred_supplier_code', i.preferred_supplier_code);
  }
  const stockPlace = (file: string, line: number, code: string) => {
    const d = dlv.get(code);
    if (!d) add(file, line, 'store_node_code', `${code} is not in ${f('deliveryNodes')}`);
    else if (!d.holds_stock) add(file, line, 'store_node_code', `${code} does not hold stock`);
  };
  const placed = new Set<string>();
  for (const l of b.itemLocations) {
    if (!items.has(l.item_code)) {
      add(f('itemLocations'), l.line, 'item_code', `${l.item_code} is not in ${f('items')}`);
    }
    stockPlace(f('itemLocations'), l.line, l.store_node_code);
    supplierRef(f('itemLocations'), l.line, 'preferred_supplier_code', l.preferred_supplier_code);
    const k = `${l.item_code} ${l.store_node_code}`;
    if (placed.has(k))
      add(f('itemLocations'), l.line, 'item_code', 'this item and store are listed twice');
    placed.add(k);
  }
  for (const o of b.openingStock) {
    if (!placed.has(`${o.item_code} ${o.store_node_code}`)) {
      add(
        f('openingStock'),
        o.line,
        'item_code',
        `${o.item_code} is not set up at ${o.store_node_code} in ${f('itemLocations')}`,
      );
    }
  }

  // leave
  const leaveTypes = new Map<string, (typeof b.leaveTypes)[number]>();
  for (const t of b.leaveTypes) {
    leaveTypes.set(t.leave_type_code, t);
    if (t.balance_tracked !== (t.annual_days !== undefined)) {
      add(
        f('leaveTypes'),
        t.line,
        'annual_days',
        t.balance_tracked
          ? 'is required when the balance is tracked'
          : 'must be empty when the balance is not tracked',
      );
    }
  }
  for (const l of b.leaveBalances) {
    if (!users.has(l.username))
      add(f('leaveBalances'), l.line, 'username', `${l.username} is not in ${f('users')}`);
    const t = leaveTypes.get(l.leave_type_code);
    if (!t) {
      add(
        f('leaveBalances'),
        l.line,
        'leave_type_code',
        `${l.leave_type_code} is not in ${f('leaveTypes')}`,
      );
    } else if (!t.balance_tracked) {
      add(f('leaveBalances'), l.line, 'leave_type_code', `${l.leave_type_code} has no balance`);
    }
  }

  // rostering
  const settings = new Set<string>();
  for (const s of b.rosterSettings) {
    if (settings.has(s.setting))
      add(f('rosterSettings'), s.line, 'setting', `${s.setting} is listed twice`);
    settings.add(s.setting);
  }
  for (const t of b.shiftTemplates) {
    if (!org.has(t.roster_node_code)) {
      add(
        f('shiftTemplates'),
        t.line,
        'roster_node_code',
        `${t.roster_node_code} is not in ${f('orgNodes')}`,
      );
    }
    if (!roles.has(t.job_role_code)) {
      add(
        f('shiftTemplates'),
        t.line,
        'job_role_code',
        `${t.job_role_code} is not in ${f('jobRoles')}`,
      );
    }
    if (t.start_time === t.end_time)
      add(f('shiftTemplates'), t.line, 'end_time', 'must differ from the start');
  }

  // events
  for (const e of b.events) {
    const place = org.get(e.org_node_code);
    if (!place) {
      add(f('events'), e.line, 'org_node_code', `${e.org_node_code} is not in ${f('orgNodes')}`);
    } else if (place.kind !== 'outlet' && place.kind !== 'site') {
      // events are planned for a whole outlet (ADR 016)
      add(
        f('events'),
        e.line,
        'org_node_code',
        `${e.org_node_code} is a ${place.kind}: events are for a whole outlet`,
      );
    }
    if (e.ends_at <= e.starts_at) add(f('events'), e.line, 'ends_at', 'must be after the start');
    for (const r of e.requirements) {
      if (r.kind === 'item') {
        const i = items.get(r.item);
        if (!i) add(f('events'), e.line, 'requirements', `${r.item} is not in ${f('items')}`);
        else if (i.base_unit !== r.unit) {
          add(
            f('events'),
            e.line,
            'requirements',
            `${r.item} is counted in ${i.base_unit}, not ${r.unit}`,
          );
        }
      } else if (!roles.has(r.role)) {
        add(f('events'), e.line, 'requirements', `${r.role} is not in ${f('jobRoles')}`);
      }
    }
  }

  validateMenu(b, add, { items, org, dlv, placed });
  validateActivity(b, add, { items, org, dlv, placed }, users);
  validateTasks(b, add, { items, org, dlv, placed }, users, roles);
  return issues;
}

/**
 * Checklists (file 29) and the test-only tasks, maintenance and prep files (30 to 32,
 * ADR 020): every place, person and job role exists, and each template's rows agree.
 * Whether people may do it there is checked by the database functions the loader calls.
 */
function validateTasks(
  b: Bundle,
  add: Add,
  k: Known,
  users: Map<string, Bundle['users'][number]>,
  roles: Map<string, Set<string>>,
): void {
  const f = (key: keyof typeof FILES) => FILES[key].file;
  const place = (file: string, line: number, column: string, code: string) => {
    if (!k.org.has(code)) add(file, line, column, `${code} is not in ${f('orgNodes')}`);
  };
  const person = (file: string, line: number, column: string, username?: string) => {
    if (username !== undefined && !users.has(username)) {
      add(file, line, column, `${username} is not in ${f('users')}`);
    }
  };
  const assignee = (file: string, line: number, a: AssignTo) => {
    if (a.mode === 'person') person(file, line, 'assign_to', a.username);
    if (a.mode === 'job_role' && !roles.has(a.role)) {
      add(file, line, 'assign_to', `${a.role} is not in ${f('jobRoles')}`);
    }
  };

  const templates = new Map<string, Bundle['checklistTemplates'][number]>();
  const steps = new Map<string, Set<number>>();
  for (const t of b.checklistTemplates) {
    const file = f('checklistTemplates');
    const first = templates.get(t.template_code);
    if (!first) {
      templates.set(t.template_code, t);
      place(file, t.line, 'place_code', t.place_code);
      assignee(file, t.line, t.assign_to);
    } else {
      for (const col of ['place_code', 'name', 'schedule', 'assign_to'] as const) {
        if (JSON.stringify(first[col]) !== JSON.stringify(t[col])) {
          add(file, t.line, col, `differs from line ${first.line} of ${t.template_code}`);
        }
      }
    }
    const seen = steps.get(t.template_code) ?? new Set<number>();
    if (seen.has(t.step)) add(file, t.line, 'step', `step ${t.step} is listed twice`);
    seen.add(t.step);
    steps.set(t.template_code, seen);
    if (t.min !== undefined && t.max !== undefined && t.min > t.max) {
      add(file, t.line, 'min', 'must not be more than max');
    }
    if ((t.min !== undefined || t.max !== undefined) && t.step_kind !== 'number') {
      add(file, t.line, 'step_kind', 'only a number step has a range');
    }
  }

  for (const t of b.tasks) {
    place(f('tasks'), t.line, 'place_code', t.place_code);
    assignee(f('tasks'), t.line, t.assign_to);
    person(f('tasks'), t.line, 'created_by', t.created_by);
    person(f('tasks'), t.line, 'done_by', t.done_by);
    if (
      t.done_by !== undefined &&
      t.assign_to.mode === 'person' &&
      t.assign_to.username !== t.done_by
    ) {
      add(f('tasks'), t.line, 'done_by', 'must be the person it is assigned to');
    }
  }
  for (const m of b.maintenance) {
    place(f('maintenance'), m.line, 'place_code', m.place_code);
    person(f('maintenance'), m.line, 'reported_by', m.reported_by);
    person(f('maintenance'), m.line, 'assigned_to', m.assigned_to);
    person(f('maintenance'), m.line, 'assigned_by', m.assigned_by);
    if ((m.assigned_to === undefined) !== (m.assigned_by === undefined)) {
      add(f('maintenance'), m.line, 'assigned_by', 'assigned_to and assigned_by go together');
    }
  }
  const madeAt = new Set(
    b.prepLocations
      .filter((p) => p.made_here)
      .map((p) => `${p.prep_item_code} ${p.store_node_code}`),
  );
  for (const p of b.prepTasks) {
    if (!k.dlv.has(p.store_node_code)) {
      add(
        f('prepTasks'),
        p.line,
        'store_node_code',
        `${p.store_node_code} is not in ${f('deliveryNodes')}`,
      );
    }
    if (!madeAt.has(`${p.prep_item_code} ${p.store_node_code}`)) {
      add(
        f('prepTasks'),
        p.line,
        'prep_item_code',
        `${p.prep_item_code} is not made at ${p.store_node_code} in ${f('prepLocations')}`,
      );
    }
    assignee(f('prepTasks'), p.line, p.assign_to);
    person(f('prepTasks'), p.line, 'created_by', p.created_by);
  }
}

/**
 * The test-only activity files 25 to 28 and 33 (ADR 017, 028): every code and person exists. Who may
 * do what (rostering rules, production rights, approvals) is checked by the database
 * functions the loader calls as each person.
 */
function validateActivity(
  b: Bundle,
  add: Add,
  k: Known,
  users: Map<string, Bundle['users'][number]>,
): void {
  const f = (key: keyof typeof FILES) => FILES[key].file;
  const person = (file: string, line: number, column: string, username: string) => {
    if (!users.has(username)) add(file, line, column, `${username} is not in ${f('users')}`);
  };
  const store = (file: string, line: number, code: string) => {
    const d = k.dlv.get(code);
    if (!d) add(file, line, 'store_node_code', `${code} is not in ${f('deliveryNodes')}`);
    else if (!d.holds_stock) add(file, line, 'store_node_code', `${code} does not hold stock`);
  };

  const templates = new Set(
    b.shiftTemplates.map((t) => `${t.roster_node_code} ${t.shift_name} ${t.job_role_code}`),
  );
  for (const s of b.shifts) {
    if (!templates.has(`${s.roster_node_code} ${s.shift_name} ${s.job_role_code}`)) {
      add(
        f('shifts'),
        s.line,
        'shift_name',
        `${s.shift_name} for ${s.job_role_code} at ${s.roster_node_code} is not in ${f('shiftTemplates')}`,
      );
    }
    person(f('shifts'), s.line, 'username', s.username);
    person(f('shifts'), s.line, 'rostered_by', s.rostered_by);
  }

  const madeAt = new Set(
    b.prepLocations
      .filter((p) => p.made_here)
      .map((p) => `${p.prep_item_code} ${p.store_node_code}`),
  );
  for (const p of b.production) {
    store(f('production'), p.line, p.store_node_code);
    if (!madeAt.has(`${p.prep_item_code} ${p.store_node_code}`)) {
      add(
        f('production'),
        p.line,
        'prep_item_code',
        `${p.prep_item_code} is not made at ${p.store_node_code} in ${f('prepLocations')}`,
      );
    }
    person(f('production'), p.line, 'made_by', p.made_by);
  }

  const sold = new Set(b.menuOutlets.map((o) => `${o.menu_item_code} ${o.outlet_code}`));
  const salesLines = new Set<string>();
  for (const s of b.sales) {
    if (!sold.has(`${s.menu_item_code} ${s.outlet_code}`)) {
      add(
        f('sales'),
        s.line,
        'menu_item_code',
        `${s.menu_item_code} is not sold at ${s.outlet_code} in ${f('menuOutlets')}`,
      );
    }
    const key = `${s.outlet_code} ${s.day} ${s.menu_item_code}`;
    if (salesLines.has(key)) add(f('sales'), s.line, 'menu_item_code', 'listed twice for that day');
    salesLines.add(key);
    person(f('sales'), s.line, 'posted_by', s.posted_by);
  }

  const counters = new Map<string, string>();
  const counted = new Set<string>();
  for (const c of b.counts) {
    store(f('counts'), c.line, c.store_node_code);
    if (!k.placed.has(`${c.item_code} ${c.store_node_code}`)) {
      add(
        f('counts'),
        c.line,
        'item_code',
        `${c.item_code} is not set up at ${c.store_node_code} in ${f('itemLocations')}`,
      );
    }
    const key = `${c.item_code} ${c.store_node_code}`;
    if (counted.has(key)) add(f('counts'), c.line, 'item_code', 'listed twice for that store');
    counted.add(key);
    // one count per store: one person counts it and one approves it
    const who = `${c.counted_by} ${c.approved_by}`;
    if ((counters.get(c.store_node_code) ?? who) !== who) {
      add(f('counts'), c.line, 'counted_by', `${c.store_node_code} is counted by one person`);
    }
    counters.set(c.store_node_code, who);
    person(f('counts'), c.line, 'counted_by', c.counted_by);
    person(f('counts'), c.line, 'approved_by', c.approved_by);
  }

  // file 33: an order's columns agree on every line; it is received after it is ordered
  const suppliers = new Set(b.suppliers.map((s) => s.supplier_code));
  const orders = new Map<string, Bundle['purchases'][number]>();
  const ordered = new Set<string>();
  const ORDER_COLUMNS = [
    'store_node_code',
    'supplier_code',
    'ordered_day',
    'ordered_by',
    'approved_by',
    'received_day',
    'received_by',
  ] as const;
  for (const p of b.purchases) {
    const file = f('purchases');
    const first = orders.get(p.order_ref);
    if (first) {
      for (const col of ORDER_COLUMNS) {
        if (first[col] !== p[col]) add(file, p.line, col, `differs from line ${first.line}`);
      }
    } else {
      orders.set(p.order_ref, p);
      store(file, p.line, p.store_node_code);
      if (!suppliers.has(p.supplier_code)) {
        add(file, p.line, 'supplier_code', `${p.supplier_code} is not in ${f('suppliers')}`);
      }
      person(file, p.line, 'ordered_by', p.ordered_by);
      person(file, p.line, 'approved_by', p.approved_by);
      if (p.ordered_by === p.approved_by) {
        add(file, p.line, 'approved_by', 'nobody approves their own order');
      }
      if (p.received_day !== undefined) {
        if (p.received_by === undefined) add(file, p.line, 'received_by', 'is required');
        else person(file, p.line, 'received_by', p.received_by);
        if (p.received_day < p.ordered_day) {
          add(file, p.line, 'received_day', 'must not be before ordered_day');
        }
      }
    }
    if (!k.placed.has(`${p.item_code} ${p.store_node_code}`)) {
      add(
        file,
        p.line,
        'item_code',
        `${p.item_code} is not set up at ${p.store_node_code} in ${f('itemLocations')}`,
      );
    }
    const key = `${p.order_ref} ${p.item_code}`;
    if (ordered.has(key)) add(file, p.line, 'item_code', 'listed twice on that order');
    ordered.add(key);
    if (p.received_day === undefined && p.received_quantity !== undefined) {
      add(file, p.line, 'received_quantity', 'needs a received_day');
    }
  }

  // file 34: one rate per person in file 07
  const paid = new Set<string>();
  for (const r of b.payRates) {
    person(f('payRates'), r.line, 'username', r.username);
    if (paid.has(r.username)) add(f('payRates'), r.line, 'username', 'is listed twice');
    paid.add(r.username);
  }

  // file 35: past sessions that end the same day, never overlapping one another
  const sessions = new Map<string, { from: number; to: number; line: number }[]>();
  for (const a of b.attendance) {
    const file = f('attendance');
    person(file, a.line, 'username', a.username);
    if (a.day > -1) add(file, a.line, 'day', 'must be a past day, like -1');
    if (a.clock_out <= a.clock_in) {
      add(file, a.line, 'clock_out', 'must be after clock_in on the same day');
      continue;
    }
    const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const from = a.day * 1440 + mins(a.clock_in);
    const to = a.day * 1440 + mins(a.clock_out);
    const theirs = sessions.get(a.username) ?? [];
    const clash = theirs.find((x) => from < x.to && x.from < to);
    if (clash) add(file, a.line, 'clock_in', `overlaps line ${clash.line}`);
    theirs.push({ from, to, line: a.line });
    sessions.set(a.username, theirs);
  }

  // file 36: a transfer's columns agree on every line; requested, then dispatched, then
  // received, each by someone else (rule 7: nobody approves their own request)
  const prepAt = new Set(b.prepLocations.map((p) => `${p.prep_item_code} ${p.store_node_code}`));
  const TRANSFER_COLUMNS = [
    'from_store_code',
    'to_store_code',
    'requested_day',
    'requested_by',
    'dispatched_day',
    'dispatched_by',
    'received_day',
    'received_by',
  ] as const;
  const transfers = new Map<string, Bundle['transfers'][number]>();
  const onTransfer = new Set<string>();
  for (const t of b.transfers) {
    const file = f('transfers');
    const first = transfers.get(t.transfer_ref);
    if (first) {
      for (const col of TRANSFER_COLUMNS) {
        if (first[col] !== t[col]) add(file, t.line, col, `differs from line ${first.line}`);
      }
    } else {
      transfers.set(t.transfer_ref, t);
      for (const [col, code] of [
        ['from_store_code', t.from_store_code],
        ['to_store_code', t.to_store_code],
      ] as const) {
        const d = k.dlv.get(code);
        if (!d) add(file, t.line, col, `${code} is not in ${f('deliveryNodes')}`);
        else if (!d.holds_stock) add(file, t.line, col, `${code} does not hold stock`);
      }
      if (t.from_store_code === t.to_store_code) {
        add(file, t.line, 'to_store_code', 'must differ from from_store_code');
      }
      person(file, t.line, 'requested_by', t.requested_by);
      if (t.dispatched_day !== undefined) {
        if (t.dispatched_by === undefined) add(file, t.line, 'dispatched_by', 'is required');
        else {
          person(file, t.line, 'dispatched_by', t.dispatched_by);
          if (t.dispatched_by === t.requested_by) {
            add(file, t.line, 'dispatched_by', 'nobody approves their own request');
          }
        }
        if (t.dispatched_day < t.requested_day) {
          add(file, t.line, 'dispatched_day', 'must not be before requested_day');
        }
      }
      if (t.received_day !== undefined) {
        if (t.dispatched_day === undefined) {
          add(file, t.line, 'received_day', 'needs a dispatched_day');
        } else if (t.received_day < t.dispatched_day) {
          add(file, t.line, 'received_day', 'must not be before dispatched_day');
        }
        if (t.received_by === undefined) add(file, t.line, 'received_by', 'is required');
        else {
          person(file, t.line, 'received_by', t.received_by);
          if (t.received_by === t.requested_by) {
            add(file, t.line, 'received_by', 'nobody approves their own request');
          }
        }
      }
    }
    const at = `${t.item_code} ${t.to_store_code}`;
    if (!k.placed.has(at) && !prepAt.has(at)) {
      add(file, t.line, 'item_code', `${t.item_code} is not set up at ${t.to_store_code}`);
    }
    const key = `${t.transfer_ref} ${t.item_code}`;
    if (onTransfer.has(key)) add(file, t.line, 'item_code', 'listed twice on that transfer');
    onTransfer.add(key);
    if (t.dispatched_day === undefined && t.dispatched_qty !== undefined) {
      add(file, t.line, 'dispatched_qty', 'needs a dispatched_day');
    }
    if (t.received_day === undefined && t.received_qty !== undefined) {
      add(file, t.line, 'received_qty', 'needs a received_day');
    }
    if ((t.received_qty ?? 0) > (t.dispatched_qty ?? t.requested_qty)) {
      add(file, t.line, 'received_qty', 'cannot be more than was dispatched');
    }
  }
}

type Add = (file: string, row: number, column: string, message: string) => void;
interface Known {
  items: Map<string, Bundle['items'][number]>;
  org: Map<string, Bundle['orgNodes'][number]>;
  dlv: Map<string, Bundle['deliveryNodes'][number]>;
  /** `item store` pairs in file 11 */
  placed: Set<string>;
}

/** Recipe lines grouped by what they are for (`prep CODE` or `menu CODE`). */
function recipeGroups(b: Bundle): Map<string, Bundle['recipes']> {
  const groups = new Map<string, Bundle['recipes']>();
  for (const r of b.recipes) {
    const k = `${r.recipe_for_kind} ${r.recipe_for_code}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return groups;
}

/** Is `store` one of `outlet`'s stores: its nearest linked place is linked at or below it? */
function storeOfOutlet(b: Bundle, k: Known, store: string, outlet: string): boolean {
  const linked = new Map<string, string[]>();
  for (const l of b.nodeLinks) {
    linked.set(l.delivery_node_code, [
      ...(linked.get(l.delivery_node_code) ?? []),
      l.org_node_code,
    ]);
  }
  let anchor: string | undefined = store;
  while (anchor && !linked.has(anchor)) anchor = k.dlv.get(anchor)?.parent_code;
  if (!anchor) return false;
  const under = (code: string) => {
    for (let c: string | undefined = code; c; c = k.org.get(c)?.parent_code) {
      if (c === outlet) return true;
    }
    return false;
  };
  return linked.get(anchor)!.some(under);
}

// Files 18-24: every code exists, units agree across files, a prep item's ingredients are
// stocked where it is made, no recipe uses itself, and a store sells for its own outlet.
function validateMenu(b: Bundle, add: Add, k: Known): void {
  const f = (key: keyof typeof FILES) => FILES[key].file;
  const conv = new Map<string, Bundle['unitConversions'][number]>();
  for (const u of b.unitConversions) {
    const i = k.items.get(u.item_code);
    if (conv.has(u.item_code)) {
      add(f('unitConversions'), u.line, 'item_code', `${u.item_code} is listed twice`);
    }
    conv.set(u.item_code, u);
    if (!i) {
      add(f('unitConversions'), u.line, 'item_code', `${u.item_code} is not in ${f('items')}`);
    } else if (i.base_unit !== u.stock_unit) {
      add(
        f('unitConversions'),
        u.line,
        'stock_unit',
        `${u.item_code} is counted in ${i.base_unit} in ${f('items')}, not ${u.stock_unit}`,
      );
    }
  }

  const prep = new Map<string, Bundle['prepItems'][number]>();
  for (const p of b.prepItems) {
    if (prep.has(p.prep_item_code)) {
      add(f('prepItems'), p.line, 'prep_item_code', `${p.prep_item_code} is listed twice`);
    }
    if (k.items.has(p.prep_item_code)) {
      add(
        f('prepItems'),
        p.line,
        'prep_item_code',
        `${p.prep_item_code} is already an item in ${f('items')}`,
      );
    }
    prep.set(p.prep_item_code, p);
  }

  const prepAt = new Map<string, boolean>(); // `prep store` -> made_here
  for (const l of b.prepLocations) {
    if (!prep.has(l.prep_item_code)) {
      add(
        f('prepLocations'),
        l.line,
        'prep_item_code',
        `${l.prep_item_code} is not in ${f('prepItems')}`,
      );
    }
    const d = k.dlv.get(l.store_node_code);
    if (!d) {
      add(
        f('prepLocations'),
        l.line,
        'store_node_code',
        `${l.store_node_code} is not in ${f('deliveryNodes')}`,
      );
    } else if (!d.holds_stock) {
      add(
        f('prepLocations'),
        l.line,
        'store_node_code',
        `${l.store_node_code} does not hold stock`,
      );
    }
    const key = `${l.prep_item_code} ${l.store_node_code}`;
    if (prepAt.has(key)) {
      add(
        f('prepLocations'),
        l.line,
        'prep_item_code',
        'this prep item and store are listed twice',
      );
    }
    prepAt.set(key, l.made_here);
  }
  for (const p of b.prepItems) {
    if (![...prepAt].some(([key, made]) => made && key.startsWith(`${p.prep_item_code} `))) {
      add(
        f('prepItems'),
        p.line,
        'prep_item_code',
        `${p.prep_item_code} is made at no store in ${f('prepLocations')}`,
      );
    }
  }

  const menu = new Map<string, Bundle['menuItems'][number]>();
  for (const m of b.menuItems) {
    if (menu.has(m.menu_item_code)) {
      add(f('menuItems'), m.line, 'menu_item_code', `${m.menu_item_code} is listed twice`);
    }
    menu.set(m.menu_item_code, m);
  }

  // recipes: references, units, one line per ingredient, every prep and menu item has one
  const unitOf = (kind: 'raw' | 'prep', code: string) =>
    kind === 'raw' ? conv.get(code)?.recipe_unit : prep.get(code)?.unit;
  const groups = recipeGroups(b);
  for (const [key, lines] of groups) {
    const seen = new Set<string>();
    for (const r of lines) {
      if (
        r.recipe_for_kind === 'prep' ? !prep.has(r.recipe_for_code) : !menu.has(r.recipe_for_code)
      ) {
        add(
          f('recipes'),
          r.line,
          'recipe_for_code',
          `${r.recipe_for_code} is not in ${r.recipe_for_kind === 'prep' ? f('prepItems') : f('menuItems')}`,
        );
      }
      if (r.ingredient_kind === 'raw' && !k.items.has(r.ingredient_code)) {
        add(
          f('recipes'),
          r.line,
          'ingredient_code',
          `${r.ingredient_code} is not in ${f('items')}`,
        );
      } else if (r.ingredient_kind === 'prep' && !prep.has(r.ingredient_code)) {
        add(
          f('recipes'),
          r.line,
          'ingredient_code',
          `${r.ingredient_code} is not in ${f('prepItems')}`,
        );
      } else {
        const unit = unitOf(r.ingredient_kind, r.ingredient_code);
        if (unit === undefined) {
          add(
            f('recipes'),
            r.line,
            'ingredient_code',
            `${r.ingredient_code} has no recipe unit in ${f('unitConversions')}`,
          );
        } else if (unit !== r.unit) {
          add(
            f('recipes'),
            r.line,
            'unit',
            `${r.ingredient_code} is used in ${unit}, not ${r.unit}`,
          );
        }
      }
      if (seen.has(r.ingredient_code)) {
        add(
          f('recipes'),
          r.line,
          'ingredient_code',
          `${r.ingredient_code} is listed twice in ${key}`,
        );
      }
      seen.add(r.ingredient_code);
    }
  }
  for (const p of b.prepItems) {
    if (!groups.has(`prep ${p.prep_item_code}`)) {
      add(
        f('prepItems'),
        p.line,
        'prep_item_code',
        `${p.prep_item_code} has no recipe in ${f('recipes')}`,
      );
    }
  }
  for (const m of b.menuItems) {
    if (!groups.has(`menu ${m.menu_item_code}`)) {
      add(
        f('menuItems'),
        m.line,
        'menu_item_code',
        `${m.menu_item_code} has no recipe in ${f('recipes')}`,
      );
    }
  }

  // no prep item is made from itself, directly or through sub-recipes
  const uses = new Map<string, string[]>();
  for (const r of b.recipes) {
    if (r.recipe_for_kind === 'prep' && r.ingredient_kind === 'prep') {
      uses.set(r.recipe_for_code, [...(uses.get(r.recipe_for_code) ?? []), r.ingredient_code]);
    }
  }
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean =>
    (uses.get(from) ?? []).some(
      (n) => n === target || (!seen.has(n) && (seen.add(n), reaches(n, target, seen))),
    );
  for (const [code, lines] of groups) {
    const [kind, p] = code.split(' ') as ['prep' | 'menu', string];
    if (kind === 'prep' && reaches(p, p)) {
      add(
        f('recipes'),
        lines[0]!.line,
        'recipe_for_code',
        `${p} is made from itself through its sub-recipes`,
      );
    }
  }

  // a prep item's ingredients are stocked at every store that makes it
  for (const l of b.prepLocations) {
    if (!l.made_here) continue;
    for (const r of groups.get(`prep ${l.prep_item_code}`) ?? []) {
      const stocked =
        r.ingredient_kind === 'raw'
          ? k.placed.has(`${r.ingredient_code} ${l.store_node_code}`)
          : prepAt.has(`${r.ingredient_code} ${l.store_node_code}`);
      if (!stocked) {
        add(
          f('prepLocations'),
          l.line,
          'store_node_code',
          `${l.prep_item_code} is made at ${l.store_node_code}, which does not stock its ingredient ${r.ingredient_code} (${r.ingredient_kind === 'raw' ? f('itemLocations') : f('prepLocations')})`,
        );
      }
    }
  }

  // menu outlets: the item exists, the outlet is an outlet, the store sells for it
  const listed = new Set<string>();
  const posCodes = new Set<string>();
  for (const o of b.menuOutlets) {
    if (!menu.has(o.menu_item_code)) {
      add(
        f('menuOutlets'),
        o.line,
        'menu_item_code',
        `${o.menu_item_code} is not in ${f('menuItems')}`,
      );
    }
    const outlet = k.org.get(o.outlet_code);
    if (!outlet || (outlet.kind !== 'outlet' && outlet.kind !== 'site')) {
      add(
        f('menuOutlets'),
        o.line,
        'outlet_code',
        `${o.outlet_code} is not an outlet in ${f('orgNodes')}`,
      );
    }
    const store = k.dlv.get(o.sold_from_store_code);
    if (!store || !store.holds_stock) {
      add(
        f('menuOutlets'),
        o.line,
        'sold_from_store_code',
        `${o.sold_from_store_code} is not a place that holds stock in ${f('deliveryNodes')}`,
      );
    } else if (outlet && !storeOfOutlet(b, k, o.sold_from_store_code, o.outlet_code)) {
      add(
        f('menuOutlets'),
        o.line,
        'sold_from_store_code',
        `${o.sold_from_store_code} is not one of ${o.outlet_code}'s stores (${f('nodeLinks')})`,
      );
    }
    const key = `${o.menu_item_code} ${o.outlet_code}`;
    if (listed.has(key))
      add(f('menuOutlets'), o.line, 'menu_item_code', 'this menu item and outlet are listed twice');
    listed.add(key);
    if (o.pos_code !== undefined) {
      const pos = `${o.outlet_code} ${o.pos_code}`;
      if (posCodes.has(pos))
        add(
          f('menuOutlets'),
          o.line,
          'pos_code',
          `POS code ${o.pos_code} is used twice at ${o.outlet_code}`,
        );
      posCodes.add(pos);
    }
  }

  const procs = new Set<string>();
  for (const p of b.prepProcedures) {
    if (!prep.has(p.prep_item_code)) {
      add(
        f('prepProcedures'),
        p.line,
        'prep_item_code',
        `${p.prep_item_code} is not in ${f('prepItems')}`,
      );
    }
    const key = `${p.prep_item_code} ${p.step}`;
    if (procs.has(key)) add(f('prepProcedures'), p.line, 'step', `step ${p.step} is listed twice`);
    procs.add(key);
  }
}

/**
 * Not blockers: a menu item sold from a store that does not stock one of its ingredients.
 * Selling it would take that ingredient below zero there (sales may; ADR 014).
 */
export function menuWarnings(b: Bundle): Issue[] {
  const warnings: Issue[] = [];
  const placed = new Set(b.itemLocations.map((l) => `${l.item_code} ${l.store_node_code}`));
  const prepAt = new Set(b.prepLocations.map((l) => `${l.prep_item_code} ${l.store_node_code}`));
  const groups = recipeGroups(b);
  for (const o of b.menuOutlets) {
    for (const r of groups.get(`menu ${o.menu_item_code}`) ?? []) {
      const key = `${r.ingredient_code} ${o.sold_from_store_code}`;
      if (r.ingredient_kind === 'raw' ? !placed.has(key) : !prepAt.has(key)) {
        warnings.push({
          file: FILES.menuOutlets.file,
          row: o.line,
          column: 'sold_from_store_code',
          message: `${o.menu_item_code} is sold from ${o.sold_from_store_code}, which does not stock ${r.ingredient_code}: selling it will take ${r.ingredient_code} below zero there`,
        });
      }
    }
  }
  return warnings;
}
