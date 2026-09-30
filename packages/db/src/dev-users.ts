// Test users offered by the dev-only login (apps/web /dev-login, ADR 004): people from the
// two test customers in docs/onboarding/test-data, identified by customer code and
// username (ids are generated when the files are loaded). app-reads.db.test.ts fails if
// one no longer exists. Never used in production.

export interface DevUser {
  customer: 'TEST-COMPANY' | 'TEST-SOLO-COMPANY';
  username: string;
  name: string;
  roles: string;
}

const company = (username: string, name: string, roles: string): DevUser => ({
  customer: 'TEST-COMPANY',
  username,
  name,
  roles,
});
const solo = (username: string, name: string, roles: string): DevUser => ({
  customer: 'TEST-SOLO-COMPANY',
  username,
  name,
  roles,
});

export const DEV_USERS: readonly DevUser[] = [
  // Test Bar 3.0 (standalone bar): the Bar Manager runs the outlet
  company('test.bar-manager.3.0', 'Test Bar Manager 3.0', 'Outlet Manager · Test Bar 3.0'),
  company('test.floor-manager.3.0', 'Test Floor Manager 3.0', 'Department Head · Floor Service'),
  company('test.head-cook.3.0', 'Test Head Cook 3.0', 'Department Head, Store Keeper · Kitchen'),
  company('test.cook.3.0', 'Test Cook 3.0', 'Stock User · Kitchen Store'),
  company('test.head-bartender.3.0', 'Test Head Bartender 3.0', 'Supervisor, Stock User · Bar'),
  company('test.server.3.0', 'Test Server 3.0', 'Staff · Floor Service'),
  company('test.host.3.0', 'Test Host 3.0', 'Staff · Floor Service'),
  // Test Hotel & Bar 1.0 (full hotel: departments and four stores)
  company(
    'test.general-manager.1.0',
    'Test General Manager 1.0',
    'Outlet Manager, User Admin · Hotel 1.0',
  ),
  company('test.bar-manager.1.0', 'Test Bar Manager 1.0', 'Department Head, Store Keeper · Bar'),
  company('test.store-keeper.1.0', 'Test Store Keeper 1.0', 'Store Keeper · Main Store'),
  company('test.receiving-clerk.1.0', 'Test Receiving Clerk 1.0', 'Stock User · Main Store'),
  company('test.hr-executive.1.0', 'Test HR Executive 1.0', 'Outlet HR · Hotel 1.0'),
  company(
    'test.cost-controller.1.0',
    'Test Cost Controller 1.0',
    'Cost Controller · Hotel 1.0 stores',
  ),
  // Test Guest House 2.0 (no departments, stock at the supply point)
  company(
    'test.general-manager.2.0',
    'Test General Manager 2.0',
    'Outlet Manager · Guest House 2.0',
  ),
  company('test.cook.2.0', 'Test Cook 2.0', 'Stock User · Guest House supply point'),
  company(
    'test.front-desk-executive.2.0',
    'Test Front Desk Executive 2.0',
    'Staff, User Admin · Guest House 2.0',
  ),
  // Central kitchen, area and company
  company(
    'test.central-kitchen-manager',
    'Test Central Kitchen Manager',
    'Hub Manager · Central Kitchen Store',
  ),
  company(
    'test.central-kitchen-store-keeper',
    'Test Central Kitchen Store Keeper',
    'Store Keeper · Central Kitchen Store',
  ),
  company('test.area-manager', 'Test Area Manager', 'Area Manager · Area Mumbai'),
  company('test.hr-admin', 'Test HR Admin', 'HR Admin · Company'),
  company('test.security-admin', 'Test Security Admin', 'Security Admin · Company'),
  company('test.auditor', 'Test Auditor', 'Auditor · Company'),
  company('test.account-owner', 'Test Account Owner', 'Account Owner · Company'),
  // Test Solo Bar Co.: the owner runs the bar and owns the account
  solo(
    'test.solo.bar-manager',
    'Test Bar Manager',
    'Outlet Manager, Account Owner · Test Solo Bar',
  ),
  solo('test.solo.head-bartender', 'Test Head Bartender', 'Supervisor, Store Keeper · Bar'),
  solo('test.solo.cook', 'Test Cook', 'Stock User · Kitchen Store'),
];

/** The dev login form value for a user: `<customer>/<username>`. */
export const devUserKey = (u: Pick<DevUser, 'customer' | 'username'>): string =>
  `${u.customer}/${u.username}`;
