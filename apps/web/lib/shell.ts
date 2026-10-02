import 'server-only';
import { cache } from 'react';
import { requireUser, type CurrentUser } from './auth/server';
import { sql, withUser } from './db';
import type { NavInput } from './nav';

export interface NodeRow {
  id: string;
  type: 'org' | 'delivery';
  kind: string;
  name: string;
  depth: number;
  derived: boolean;
  timezone: string | null;
  holds_stock: boolean;
}

export interface HomePlace {
  id: string;
  name: string;
  kind: string;
  /** at an outlet or below: has shifts, a clock and swaps (audit #13) */
  at_workplace: boolean;
}

export interface Shell {
  user: CurrentUser;
  domains: Map<string, 'view' | 'modify'>;
  /** access group codes (core.my_access(), SELF included): the bottom nav's profile */
  groups: Set<string>;
  nodes: NodeRow[];
  /** where the person works (their worker row), if they have one */
  home: HomePlace | null;
  inboxCount: number;
  unreadCount: number;
  /** they can read a recipe or see menu costs somewhere (the Menu tab) */
  menu: boolean;
  /** they record production somewhere (the Production tab) */
  production: boolean;
}

const MENU_DOMAINS = ['MENU', 'DERIVED_MENU', 'RECIPES', 'RECIPES_TEAM'];

/** Everything the app layout needs, in one withUser transaction. */
export const loadShell = cache(async (): Promise<Shell> => {
  const user = await requireUser();
  return withUser(user.id, async (tx) => {
    const domains = await sql<{ domain: string; access: 'view' | 'modify' }>`
      select * from core.my_domains()`.execute(tx);
    const groups = await sql<{ access_group: string }>`
      select distinct access_group from core.my_access()`.execute(tx);
    const has = (d: string) => domains.rows.some((r) => r.domain === d);
    const nodes = await sql<NodeRow>`
      select id, type, kind, name, depth, derived, timezone, holds_stock from core.nodes()`.execute(
      tx,
    );
    const home = await sql<HomePlace>`select * from core.my_home()`.execute(tx);
    // approvals, plus expired batches and maintenance requests to assign (ADR 020)
    const inbox = await sql<{ n: number }>`
      select (select count(*) from wf.my_inbox())::int
           + (select count(*) from ops.my_to_assign())::int as n`.execute(tx);
    const unread = await sql<{ n: number }>`
      select count(*)::int as n from ops.notification
       where owner_user_id = core.current_user_id() and read_at is null`.execute(tx);
    // RLS shows only the recipes they may read; menu places are where they see costs
    const menu = MENU_DOMAINS.some(has)
      ? await sql<{ v: boolean }>`
          select exists (select 1 from inv.recipe) or exists (select 1 from menu.my_menu_places())
            as v`.execute(tx)
      : null;
    const production =
      has('PRODUCTION') || has('PRODUCTION_TEAM')
        ? await sql<{ v: boolean }>`
            select exists (select 1 from core.screen_places('production')) as v`.execute(tx)
        : null;
    return {
      user,
      domains: new Map(domains.rows.map((d) => [d.domain, d.access])),
      groups: new Set(groups.rows.map((g) => g.access_group)),
      nodes: nodes.rows,
      home: home.rows[0] ?? null,
      inboxCount: inbox.rows[0]?.n ?? 0,
      unreadCount: unread.rows[0]?.n ?? 0,
      menu: menu?.rows[0]?.v ?? false,
      production: production?.rows[0]?.v ?? false,
    };
  });
});

/** What the bottom nav and Home's links are chosen from. */
export function navInput(shell: Shell): NavInput {
  return {
    groups: shell.groups,
    domains: new Set(shell.domains.keys()),
    menu: shell.menu,
    production: shell.production,
  };
}
