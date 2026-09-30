import { ACCESS_GROUPS } from '@outlet-ops/domain';
import type { Bundle, Issue } from './files';
import { FILES } from './files';

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

  // job roles: product groups only, one row per role and format, an `any` row per role
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
      if (!ASSIGNABLE.has(a.group)) {
        add(f('jobRoles'), r.line, 'default_access', `${a.group} is not an access group`);
      }
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
    if (!ASSIGNABLE.has(e.access_group)) {
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
    if (!org.has(e.org_node_code)) {
      add(f('events'), e.line, 'org_node_code', `${e.org_node_code} is not in ${f('orgNodes')}`);
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
  return issues;
}
