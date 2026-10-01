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
  return issues;
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
