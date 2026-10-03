import 'server-only';
import { cache } from 'react';
import { requireUser, type CurrentUser } from './auth/server';
import { sql, withUser } from './db';
import type { ModuleCode } from '@outlet-ops/domain';
import { isProductCode } from './custom-groups';
import { modulesOn, withModules } from './modules';
import { navProfile, type NavInput } from './nav';
import type { ScreenInput } from './screens';

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
  /** core.my_domains(), without the domains of switched-off modules (ADR 026) */
  domains: Map<string, 'view' | 'modify'>;
  /** the company's modules that are on (ADR 026) */
  modules: ReadonlySet<ModuleCode>;
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
  /** what Reports offers them (ADR 023) */
  reports: NavInput['reports'];
}

const MENU_DOMAINS = ['MENU', 'DERIVED_MENU', 'RECIPES', 'RECIPES_TEAM'];

/** Everything the app layout needs, in one withUser transaction. */
export const loadShell = cache(async (): Promise<Shell> => {
  const user = await requireUser();
  return withUser(user.id, async (tx) => {
    const all = await sql<{ domain: string; access: 'view' | 'modify' }>`
      select * from core.my_domains()`.execute(tx);
    const modules = modulesOn(
      (
        await sql<{ code: string; on: boolean }>`select code, "on" from core.my_modules()`.execute(
          tx,
        )
      ).rows,
    );
    const domainMap = withModules(new Map(all.rows.map((d) => [d.domain, d.access])), modules);
    // the product roles a custom group stands in for count too (ADR 027)
    const groups = await sql<{ access_group: string }>`
      select distinct access_group from core.my_access()
      union select r from core.my_acting_roles() r`.execute(tx);
    const has = (d: string) => domainMap.has(d);
    const nodes = await sql<NodeRow>`
      select id, type, kind, name, depth, derived, timezone, holds_stock from core.nodes()`.execute(
      tx,
    );
    const home = await sql<HomePlace>`select * from core.my_home()`.execute(tx);
    // approvals, plus expired batches and maintenance requests to assign (ADR 020)
    const inbox = await sql<{ n: number }>`
      select (select count(*) from wf.my_inbox())::int
           + (select count(*) from ops.my_to_assign() a
               where (select "on" from core.my_modules()
                       where code = case a.kind when 'expiry' then 'production'
                                                else 'maintenance' end))::int as n`.execute(tx);
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
    // frontline staff have only their own week; others ask rpt.my_reports() (ADR 023)
    // product roles only: a custom group's own code says nothing about the kind of work
    const groupSet = new Set(groups.rows.map((g) => g.access_group).filter(isProductCode));
    const listed =
      navProfile(groupSet) === 'frontline'
        ? null
        : await sql<{ report: string }>`select report from rpt.my_reports()`.execute(tx);
    const reports: NavInput['reports'] = listed
      ? listed.rows.some((r) => r.report !== 'my_week')
        ? 'business'
        : listed.rows.length > 0
          ? 'mine'
          : 'none'
      : home.rows.length > 0
        ? 'mine'
        : 'none';
    return {
      user,
      domains: domainMap,
      modules,
      groups: groupSet,
      nodes: nodes.rows,
      home: home.rows[0] ?? null,
      inboxCount: inbox.rows[0]?.n ?? 0,
      unreadCount: unread.rows[0]?.n ?? 0,
      menu: menu?.rows[0]?.v ?? false,
      production: production?.rows[0]?.v ?? false,
      reports,
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
    reports: shell.reports,
  };
}

/** What the Me page and Home's tiles are chosen from (UX-6). */
export function screenInput(shell: Shell): ScreenInput {
  return { ...navInput(shell), access: shell.domains, atWork: shell.home?.at_workplace ?? false };
}
