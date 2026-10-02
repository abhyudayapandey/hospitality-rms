// Modules a company can switch off (UX-3b, ADR 026). The same codes as
// core.module_codes() in the database; a test keeps the two equal. Everything else (stock,
// roster, tasks, inbox, reports, admin) is always on.

export const MODULES = [
  {
    code: 'events',
    name: 'Events',
    what: 'Banquets and functions: covers, staff and stock needed.',
  },
  {
    code: 'swaps',
    name: 'Shift swaps',
    what: 'Staff offer a shift to a colleague; the manager approves.',
  },
  {
    code: 'leave',
    name: 'Leave',
    what: 'Leave requests, approvals and balances.',
  },
  {
    code: 'production',
    name: 'Production',
    what: 'Batches made in the kitchen or bar, with expiry.',
  },
  {
    code: 'prep_lists',
    name: 'Prep lists',
    what: 'Daily prep tasks from par levels. Needs Production.',
    needs: 'production',
  },
  {
    code: 'checklists',
    name: 'Checklists',
    what: 'Opening, closing and temperature rounds on a schedule.',
  },
  {
    code: 'maintenance',
    name: 'Maintenance',
    what: 'Report a problem; engineering assigns and fixes it.',
  },
  {
    code: 'menu_sales',
    name: 'Menu and sales',
    what: 'Menu costs and prices, daily sales and variance. Off: no sales figures in reports.',
  },
] as const satisfies readonly { code: string; name: string; what: string; needs?: string }[];

export type ModuleCode = (typeof MODULES)[number]['code'];

export const MODULE_CODES: readonly ModuleCode[] = MODULES.map((m) => m.code);

export function isModuleCode(s: string): s is ModuleCode {
  return (MODULE_CODES as readonly string[]).includes(s);
}
