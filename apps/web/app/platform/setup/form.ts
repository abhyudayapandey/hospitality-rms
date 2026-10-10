import { TILE_BY_CODE, type ExtraCode } from '@outlet-ops/domain';
import {
  STEPS,
  UNITS,
  draftBundles,
  outletPlan,
  peopleFromPaste,
  readDraft,
  type DraftOutlet,
  type SetupDraft,
  type Step,
} from '@outlet-ops/onboarding/templates';

// The set-up wizard's forms (ADR 064): each screen posts plain fields, and this applies them
// to the draft. Pure, so the rules are unit-tested; the route saves and moves on.

export type Fields = Map<string, string[]>;

export function fieldsOf(form: FormData): Fields {
  const f: Fields = new Map();
  for (const [k, v] of form.entries()) {
    if (typeof v !== 'string') continue;
    f.set(k, [...(f.get(k) ?? []), v]);
  }
  return f;
}

const one = (f: Fields, k: string) => (f.get(k)?.[0] ?? '').trim();

/** "Which orders need approving" (ADR 092): unusual ones, every one, or above an amount. */
function purchaseApprovalOf(mode: string, above: string): string {
  if (mode === 'every') return 'every';
  const n = Math.round(Number(above.replace(/[^0-9.]/g, '')));
  return mode === 'above' && n > 0 ? `above:${n}` : '';
}
const all = (f: Fields, k: string) => f.get(k) ?? [];

export const isStep = (s: string): s is Step => (STEPS as readonly string[]).includes(s);

/** What a form changes; `notes` are shown on the next screen (rows it could not match). */
export function applyForm(
  draft: SetupDraft,
  step: Step,
  f: Fields,
  newKey: () => string,
): { draft: SetupDraft; notes: string[]; outlet?: string } {
  const d = readDraft(structuredClone(draft));
  const notes: string[] = [];
  if (step === 'company') {
    d.company = {
      name: one(f, 'name'),
      code: one(f, 'code').toUpperCase(),
      country: one(f, 'country') || 'India',
      currency: (one(f, 'currency') || 'INR').toUpperCase(),
      timezone: one(f, 'timezone') || 'Asia/Kolkata',
      isTest: one(f, 'isTest') === 'yes',
      ownerName: one(f, 'ownerName'),
      ownerEmail: one(f, 'ownerEmail').toLowerCase(),
      purchaseApproval: purchaseApprovalOf(one(f, 'approval'), one(f, 'approvalAbove')),
    };
  }
  if (step === 'outlets') {
    const op = one(f, 'op');
    const key = one(f, 'key');
    if (op === 'remove') {
      d.outlets = d.outlets.filter((o) => o.key !== key);
      d.people = d.people.map((p) => (p.outlet === key ? { ...p, outlet: '' } : p));
    }
    if (op === 'save') {
      const tile = TILE_BY_CODE.get(one(f, 'tile'));
      if (tile) {
        const old = d.outlets.find((o) => o.key === key);
        const extras = all(f, 'extra').filter((x): x is ExtraCode =>
          tile.offers.includes(x as ExtraCode),
        );
        const fresh: DraftOutlet = readDraft({
          outlets: [{ key: old?.key ?? newKey(), tile: tile.code, extras }],
        }).outlets[0]!;
        const next: DraftOutlet = {
          ...fresh,
          // a new kind of outlet or new extras start its departments, roles and stock again
          ...(old && old.tile === tile.code && sameSet(old.extras, extras)
            ? {
                departments: old.departments,
                roles: old.roles,
                stock: old.stock,
                items: old.items,
                ownItems: old.ownItems,
              }
            : {}),
          name: one(f, 'name'),
          area: one(f, 'area'),
          location: one(f, 'location'),
          radius: one(f, 'radius'),
        };
        if (!next.departments) delete next.departments;
        d.outlets = old
          ? d.outlets.map((o) => (o.key === old.key ? next : o))
          : [...d.outlets, next];
        return { draft: d, notes, outlet: next.key };
      }
    }
  }
  if (step === 'departments') {
    for (const o of d.outlets) {
      if (!f.has(`d:${o.key}`)) continue;
      o.departments = all(f, `dept:${o.key}`);
      o.items = one(f, `items:${o.key}`) === 'yes';
    }
  }
  if (step === 'roles') {
    for (const o of d.outlets) {
      for (const [k, [v]] of f) {
        const m = /^role:([^:]+):(.+)$/.exec(k);
        if (!m || m[1] !== o.key) continue;
        const code = m[2]!;
        if (v === 'covered_by') {
          const by = one(f, `by:${o.key}:${code}`);
          o.roles[code] = by && by !== code ? { mode: 'covered_by', by } : { mode: 'have' };
        } else if (v === 'not_done') o.roles[code] = { mode: 'not_done' };
        else o.roles[code] = { mode: 'have' };
      }
    }
  }
  if (step === 'people') {
    const n = Number(one(f, 'pn')) || 0;
    const people = [];
    for (let i = 0; i < n; i++) {
      const p = {
        name: one(f, `p.${i}.name`),
        email: one(f, `p.${i}.email`).toLowerCase(),
        role: one(f, `p.${i}.role`),
        outlet: one(f, `p.${i}.outlet`),
      };
      if (one(f, `p.${i}.remove`) === 'yes') continue;
      if (!p.name && !p.email && !p.role) continue;
      people.push(p);
    }
    d.people = people;
    const pasted = one(f, 'paste');
    if (pasted) {
      const r = peopleFromPaste(d, pasted);
      d.people.push(...r.people);
      notes.push(...r.notes);
    }
  }
  if (step === 'stock') {
    for (const o of d.outlets) {
      if (!f.has(`st:${o.key}`)) continue;
      let plan;
      try {
        plan = outletPlan(d, o);
      } catch {
        continue;
      }
      o.stock = {};
      for (const i of plan.items) {
        const k = `${i.department}:${i.code}`;
        const on = one(f, `s:${o.key}:${k}`) === 'on';
        const par = one(f, `par:${o.key}:${k}`);
        if (!on || par) o.stock[k] = { off: !on, par };
      }
      const n = Number(one(f, `ownn:${o.key}`)) || 0;
      o.ownItems = [];
      for (let i = 0; i < n; i++) {
        const name = one(f, `own:${o.key}:${i}.name`);
        if (!name) continue;
        const unit = one(f, `own:${o.key}:${i}.unit`);
        o.ownItems.push({
          department: one(f, `own:${o.key}:${i}.dept`),
          name,
          unit: (UNITS as readonly string[]).includes(unit)
            ? (unit as (typeof UNITS)[number])
            : 'pcs',
          par: one(f, `own:${o.key}:${i}.par`),
        });
      }
    }
  }
  if (step === 'bundles') {
    // what the customer buys (ADR 067, 085): a usual bundle left unticked stays out of the plan;
    // one the outlets don't usually use (Hotel, Events & compliance) is in only when ticked
    const ticked = new Set(all(f, 'bundle'));
    const bundles = draftBundles(d);
    d.bundlesOff = bundles.filter((b) => b.usual && !ticked.has(b.code)).map((b) => b.code);
    d.bundlesOn = bundles.filter((b) => !b.usual && ticked.has(b.code)).map((b) => b.code);
  }
  return { draft: d, notes };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** The step a Back or Next button goes to. */
export function stepAfter(step: Step, go: string): Step {
  if (isStep(go)) return go;
  const i = STEPS.indexOf(step);
  if (go === 'back') return STEPS[Math.max(0, i - 1)]!;
  if (go === 'next') return STEPS[Math.min(STEPS.length - 1, i + 1)]!;
  return step;
}
