// Selling by bundle (ADR 067, 085): what a customer buys, a group of building blocks
// (modules.ts). Only a platform admin puts a bundle in or out of a customer's plan and switches
// single blocks inside it; nobody in the customer changes either. The base (places and people,
// access, To do, approvals, notifications, Home, Me, Admin, the reports shell) comes with every
// plan. The same codes as core.bundle_codes() and core.module_bundle() in the database; a test
// keeps them equal.

import { MODULES, type ModuleCode } from './modules';

const DEFS = [
  {
    code: 'stock_buying',
    name: 'Stock & buying',
    adds: 'Adds stores and stock, stock checks and requests, wastage, and buying from suppliers.',
  },
  {
    code: 'kitchen_bar',
    name: 'Kitchen & bar',
    adds: 'Adds recipes and costing, production and prep lists, the menu and sales.',
  },
  {
    code: 'people',
    name: 'People',
    adds: 'Adds the roster, clock-in, salaries and labour cost, leave and shift swaps.',
  },
  {
    code: 'daily_work',
    name: 'Daily work',
    adds: "Adds checklists, maintenance and today's briefing.",
  },
  // out of a plan unless the platform admin puts it in: only hotels have rooms
  {
    code: 'hotel',
    name: 'Hotel',
    adds: 'Adds room minibars.',
    outByDefault: true,
  },
  {
    code: 'events_compliance',
    name: 'Events & compliance',
    adds: 'Adds events, and the licence register with the compliance calendar.',
  },
] as const satisfies readonly {
  code: string;
  name: string;
  /** what it adds to the base, in plain words */
  adds: string;
  outByDefault?: boolean;
}[];

type Def = (typeof DEFS)[number];

export type Bundle = Def & { modules: readonly ModuleCode[] };

export const BUNDLES: readonly Bundle[] = DEFS.map((b) => ({
  ...b,
  modules: MODULES.filter((m) => m.bundle === b.code).map((m) => m.code),
}));

/** Whether a bundle is in a plan that doesn't say (core.bundle_default). */
export function inPlanByDefault(b: { code: string }): boolean {
  return !('outByDefault' in b && b.outByDefault === true);
}

export type BundleCode = Def['code'];

export const BUNDLE_CODES: readonly BundleCode[] = BUNDLES.map((b) => b.code);

/** What every plan has, whatever bundles are in it. */
export const ALWAYS_ON =
  'Every plan has places and people, access, the To do list, approvals, notifications and reports.';

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
