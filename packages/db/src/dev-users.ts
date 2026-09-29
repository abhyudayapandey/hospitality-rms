// Seeded users offered by the dev-only login (apps/web /dev-login, ADR 004). Mirrors
// seed/001_core.sql; dev-users.db.test.ts fails if they drift. Never used in production.

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
];
