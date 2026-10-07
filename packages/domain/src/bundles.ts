// Selling by bundle (ADR 067): what a customer buys. A bundle groups module switches (ADR
// 026); stock, orders, bills, recipes, the roster, clock-in, tasks and reports have no switch
// and come with every plan. Only the platform admin puts a bundle in or out of a customer's
// plan; the Account Owner turns single modules off and on inside a bundle in the plan. The
// same codes as core.bundle_codes() and core.module_bundle() in the database; a test keeps
// them equal.

import { MODULES, type ModuleCode } from './modules';

export const BUNDLES = [
  {
    code: 'stock_cost',
    name: 'Stock & cost',
    adds: 'Adds production and prep lists, the menu with its costs, and sales.',
    modules: ['production', 'prep_lists', 'menu_sales'],
  },
  {
    code: 'people_roster',
    name: 'People & roster',
    adds: 'Adds leave, shift swaps and events.',
    modules: ['leave', 'swaps', 'events'],
  },
  {
    code: 'tasks_food_safety',
    name: 'Tasks & food safety',
    adds: 'Adds food safety and cleaning checklists, and repairs.',
    modules: ['checklists', 'maintenance'],
  },
  // the first bundle out of a plan unless the platform admin puts it in (ADR 069)
  {
    code: 'compliance',
    name: 'Compliance',
    adds: 'Adds the licence register with renewal reminders, and the compliance calendar (pest control, fire drills, inspections).',
    modules: ['compliance'],
    outByDefault: true,
  },
] as const satisfies readonly {
  code: string;
  name: string;
  /** what it adds to every plan's stock, orders, roster and tasks, in plain words */
  adds: string;
  modules: readonly ModuleCode[];
  outByDefault?: boolean;
}[];

/** Whether a bundle is in a plan that doesn't say (core.bundle_default). */
export function inPlanByDefault(b: { code: string }): boolean {
  return !('outByDefault' in b && b.outByDefault === true);
}

export type BundleCode = (typeof BUNDLES)[number]['code'];
export type Bundle = (typeof BUNDLES)[number];

export const BUNDLE_CODES: readonly BundleCode[] = BUNDLES.map((b) => b.code);

/** What every plan has, whatever bundles are in it. */
export const ALWAYS_ON =
  'Every plan has stock, orders, bills, recipes, the roster, clock-in, tasks and reports.';

export function isBundleCode(s: string): s is BundleCode {
  return (BUNDLE_CODES as readonly string[]).includes(s);
}

const OF = new Map<string, Bundle>(BUNDLES.flatMap((b) => b.modules.map((m) => [m, b] as const)));

/** The bundle a module is sold in. */
export function bundleOf(module: ModuleCode): Bundle {
  return OF.get(module)!;
}

const moduleName = (code: string) => MODULES.find((m) => m.code === code)?.name ?? code;

/** The bundles some modules belong to, in BUNDLES order. */
export function bundlesFor(modules: Iterable<string>): Bundle[] {
  const want = new Set([...modules].map((m) => OF.get(m)?.code));
  return BUNDLES.filter((b) => want.has(b.code));
}

export type BundleState = 'on' | 'partly' | 'off';

export const BUNDLE_STATE_WORDS: Readonly<Record<BundleState, string>> = {
  on: 'On',
  partly: 'Partly on',
  off: 'Off',
};

/** On, Partly on or Off, worked out from which of its modules are on. */
export function bundleState(b: Bundle, on: ReadonlySet<string>): BundleState {
  const n = b.modules.filter((m) => on.has(m)).length;
  return n === b.modules.length ? 'on' : n === 0 ? 'off' : 'partly';
}

/**
 * What an outlet's template uses that the customer's plan doesn't have, in plain words:
 * "This outlet uses Checklists, part of Tasks & food safety, which isn't on for this customer".
 * `outlet` names it where several are listed (the loader's dry run).
 */
export function missingBundleNotes(
  modules: readonly string[],
  inPlan: ReadonlySet<string>,
  outlet = 'This outlet',
): string[] {
  return bundlesFor(modules)
    .filter((b) => !inPlan.has(b.code))
    .map((b) => {
      const used = b.modules.filter((m) => modules.includes(m)).map(moduleName);
      const list =
        used.length === 1 ? used[0] : `${used.slice(0, -1).join(', ')} and ${used.at(-1)}`;
      return `${outlet} uses ${list}, part of ${b.name}, which isn't on for this customer`;
    });
}
