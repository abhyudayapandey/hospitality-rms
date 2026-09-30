// Seeded users offered by the dev-only login (apps/web /dev-login, ADR 004). Mirrors
// seed/001_core.sql and seed/dev/; app-reads.db.test.ts fails if they drift. Never used in production.

export interface DevUser {
  id: string;
  name: string;
  roles: string;
}

export const DEV_USERS: readonly DevUser[] = [
  { id: '01920000-0000-7000-8000-000000000301', name: 'Sam Staff', roles: 'Staff · Outlet A' },
  { id: '01920000-0000-7000-8000-000000000302', name: 'Casey Chef', roles: 'Chef · Outlet A' },
  {
    id: '01920000-0000-7000-8000-000000000303',
    name: 'Kim Storekeeper',
    roles: 'Store Keeper · Outlet A',
  },
  {
    id: '01920000-0000-7000-8000-000000000304',
    name: 'Olivia Outlet Manager',
    roles: 'Outlet Manager · Outlet A',
  },
  {
    id: '01920000-0000-7000-8000-000000000305',
    name: 'Aria Area Manager',
    roles: 'Area Manager · Area',
  },
  {
    id: '01920000-0000-7000-8000-000000000306',
    name: 'Hugo Hub Manager',
    roles: 'Hub Manager · Hub',
  },
  {
    id: '01920000-0000-7000-8000-000000000307',
    name: 'Harper HR Admin',
    roles: 'HR Admin · Company',
  },
  {
    id: '01920000-0000-7000-8000-000000000308',
    name: 'Sasha Security Admin',
    roles: 'Security Admin · Company',
  },
  { id: '01920000-0000-7000-8000-000000000309', name: 'Avery Auditor', roles: 'Auditor · Company' },
  {
    id: '01920000-0000-7000-8000-000000000310',
    name: 'Outlet Ops AI Agent',
    roles: 'AI agent (service user)',
  },
  // Workforce dev seed (seed/dev/004_workforce_dev.sql)
  { id: '01920000-0000-7000-8000-000000000311', name: 'Priya Server', roles: 'Staff · Outlet A' },
  {
    id: '01920000-0000-7000-8000-000000000312',
    name: 'Omar Outlet B Manager',
    roles: 'Outlet Manager (people) · Outlet B',
  },
  { id: '01920000-0000-7000-8000-000000000313', name: 'Bea Server', roles: 'Staff · Outlet B' },
  { id: '01920000-0000-7000-8000-000000000314', name: 'Ravi Cook', roles: 'Staff · Outlet B' },
  { id: '01920000-0000-7000-8000-000000000315', name: 'Nisha Cleaner', roles: 'Staff · Outlet B' },
  {
    id: '01920000-0000-7000-8000-000000000316',
    name: 'Hana Hub Supervisor',
    roles: 'Site supervisor (people) · Hub',
  },
  { id: '01920000-0000-7000-8000-000000000317', name: 'Arjun Storekeeper', roles: 'Staff · Hub' },
  { id: '01920000-0000-7000-8000-000000000318', name: 'Lata Cleaner', roles: 'Staff · Hub' },
];
