// Shapes and words shared by the platform console's pages (ADR 012, 013). The console is for
// Outlet Ops staff, and it speaks plainly too (ADR 075): no codes, no job kinds, no table
// names, no raw states.

export interface PlatformCustomer {
  id: string;
  code: string;
  name: string;
  country: string | null;
  status: 'active' | 'suspended';
  is_test: boolean;
  user_count: number;
  last_activity: Date | null;
  created_at: Date;
}

const JOB_LABELS: Record<string, string> = {
  create_customer: 'Created the customer',
  import_dry_run: 'Checked their files',
  import_apply: 'Loaded their files',
  invite_logins: 'Sent sign-in invitations',
};

/** What a platform job did, in words. */
export function jobLabel(kind: string): string {
  return JOB_LABELS[kind] ?? 'Background work';
}

const JOB_STATUS: Record<string, string> = {
  queued: 'Waiting to start',
  running: 'Working on it…',
  done: 'Finished',
  failed: 'Didn’t finish',
};

/** A platform job's state, in words. */
export function jobStatus(status: string): string {
  return JOB_STATUS[status] ?? status;
}

/** A customer's state, in words. */
export const customerStatus = (s: PlatformCustomer['status']) =>
  s === 'active' ? 'Active' : 'Paused';

// The import report's rows (the loader's counts) as people say them.
const COUNT_LABELS: Record<string, string> = {
  customer: 'The company',
  'org places': 'Outlets and departments',
  'delivery places': 'Stores',
  links: 'Which stores serve which departments',
  'location settings': 'Clock-in locations',
  'access groups': 'The company’s own access groups',
  'job roles': 'Job roles',
  'job role access': 'What each job role can do',
  'extra access': 'Extra access for single people',
  'role cover': 'Who covers a missing role',
  users: 'People',
  workers: 'Staff records',
  'leave types': 'Kinds of leave',
  'leave balances': 'Leave balances',
  'pay rates': 'Pay rates',
  'roster settings': 'Roster settings',
  'shift templates': 'Usual shifts',
  suppliers: 'Suppliers',
  items: 'Stock items',
  'unit conversions': 'Pack sizes',
  'item locations': 'Items kept at each store',
  'opening stock': 'Opening stock',
  'menu items': 'Dishes',
  'menu prices': 'Dish prices',
  'menu dates backdated': 'Dishes dated back to their start',
  'POS codes': 'Till codes',
  'prep items': 'Prep items',
  'prep locations': 'Where prep is made',
  'prep procedures': 'Prep methods',
  recipes: 'Recipes',
  checklists: 'Checklists',
  rooms: 'Rooms',
  'minibar items': 'Minibar items',
  'minibar sets': 'Minibar set-ups',
  licences: 'Licences',
  'compliance jobs': 'Compliance calendar jobs',
};

/** One row of an import report, named as people say it. */
export function countLabel(key: string): string {
  return COUNT_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}
