import 'server-only';
import { cache } from 'react';
import { requireUser, type CurrentUser } from './auth/server';
import { sql, withUser } from './db';
import type { ModuleCode } from '@outlet-ops/domain';
import { isProductCode } from './custom-groups';
import { modulesOn, withModules } from './modules';
import { navProfile, type NavInput } from './nav';
import { navFlagsKey } from './nav-flags';
import { unreadLines, type NotificationRow } from './notifications-view';
import type { ScreenInput, ScreenKey } from './screens';
import { DEFAULT_TZ } from './dates';

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
  /** the time zone their dates and times are shown in: their workplace's (ADR 169) */
  tz: string;
  /** where the person works (their worker row), if they have one */
  home: HomePlace | null;
  /** their job title, beside their name in the header */
  jobTitle: string | null;
  /** the company keeps shift swaps for those who change the roster (SW-4, ADR 035) */
  inboxCount: number;
  unreadCount: number;
  /** they can read a recipe or see menu costs somewhere (the Menu tab) */
  menu: boolean;
  /** they record production somewhere (the Production tab) */
  production: boolean;
  /** what Reports offers them (ADR 023) */
  reports: NavInput['reports'];
  /** they keep or read a hotel's breakfast somewhere (ops.breakfast_outlets, ADR 094, 097) */
  breakfast: boolean;
  /** their department has licences or regular jobs on the Compliance register (ADR 124) */
  compliance: boolean;
  /** screens they may open that have nothing for them (ADR 149): their tiles are left out */
  nothing: ReadonlySet<ScreenKey>;
  /** they read the roster of more than one place (HR, ADR 150): Roster is theirs to open */
  rosterWide: boolean;
}

const MENU_DOMAINS = ['MENU', 'DERIVED_MENU', 'RECIPES', 'RECIPES_TEAM'];

/**
 * Which tabs the bottom nav offers (Menu, Make, Reports) costs about 400 ms of access checks
 * and rarely changes, so it is kept per person for a few minutes (ADR 055). The key carries
 * their domains, modules and roles: a change to any of them asks again at once. Only the nav
 * reads it; every screen still checks access in the database.
 */
const NAV_TTL_MS = 5 * 60_000;
type NavFlags = Pick<
  Shell,
  'menu' | 'production' | 'reports' | 'breakfast' | 'compliance' | 'nothing' | 'rosterWide'
>;

/**
 * A tile opens a screen with something on it (ADR 149): each screen's own list, asked only of
 * those whose access offers the tile. A screen listed here would say "You don't ..." at once.
 */
const EMPTY_CHECKS: readonly { key: ScreenKey; domains: readonly string[]; list: string }[] = [
  { key: 'excise', domains: ['EXCISE'], list: 'inv.excise_stores()' },
  { key: 'audits', domains: ['AUDITS'], list: 'ops.audit_places()' },
  { key: 'utilities', domains: ['UTILITIES'], list: 'ops.utility_places()' },
  { key: 'sops', domains: ['TRAINING'], list: 'ops.my_sops()' },
  { key: 'opened', domains: ['SHELF_LIFE'], list: "core.screen_places('opened')" },
  { key: 'roster', domains: ['ROSTER'], list: "core.screen_places('roster')" },
  { key: 'sales', domains: ['SALES', 'DERIVED_SALES'], list: "core.screen_places('sales')" },
  // a block's screen where its places hold something (ADR 150): rooms and minibars only where
  // there are rooms, linen where linen is kept, events at an outlet (not a central kitchen)
  { key: 'rooms', domains: ['ROOMS'], list: 'ops.room_outlets()' },
  { key: 'minibar', domains: ['MINIBAR'], list: 'ops.minibar_places()' },
  {
    key: 'linen',
    domains: ['LINEN'],
    list: 'ops.linen_places() p cross join lateral ops.linen_items(p.place_id) i',
  },
  { key: 'events', domains: ['EVENTS'], list: "core.screen_places('events') where kind <> 'site'" },
];
const navFlags = new Map<string, { at: number; v: NavFlags }>();

async function cachedNavFlags(key: string, load: () => Promise<NavFlags>): Promise<NavFlags> {
  const now = Date.now();
  const hit = navFlags.get(key);
  if (hit && now - hit.at < NAV_TTL_MS) return hit.v;
  const v = await load();
  if (navFlags.size > 5000) navFlags.clear();
  navFlags.set(key, { at: now, v });
  return v;
}

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
    const title = await sql<{ name: string }>`
      select jr.name from hr.worker w
        join hr.job_role jr on jr.tenant_id = w.tenant_id and jr.code = w.role_code
       where w.owner_user_id = core.current_user_id() and w.status = 'active'
       limit 1`.execute(tx);
    // the time zone dates and times are shown in (ADR 169): where they work, else the first
    // place they can see
    const tz =
      nodes.rows.find((n) => n.id === home.rows[0]?.id)?.timezone ??
      nodes.rows.find((n) => n.timezone)?.timezone ??
      DEFAULT_TZ;
    // approvals, plus expired batches and maintenance requests to assign (ADR 020), plus the
    // order desk's requests to order and orders to receive (ADR 049, 052): all of it is listed
    const inbox = await sql<{ n: number }>`
      select (select count(*) from wf.my_inbox())::int
           + (select count(*) from inv.desk_orders())::int
           -- one To do list (ADR 147): my own open tasks, late or due this 04:00 business
           -- day in their time zone, as the list groups them (groupTasks, ADR 169)
           + (select count(*) from ops.my_tasks() t
               where t.status <> 'done'
                 and (t.overdue or ((t.due_at at time zone ${tz}) - interval '4 hours')::date
                                   <= ((now() at time zone ${tz}) - interval '4 hours')::date))::int
           + (select count(*) from ops.my_to_assign() a
               where (select "on" from core.my_modules()
                       where code = case a.kind when 'expiry' then 'production'
                                                else 'maintenance' end))::int as n`.execute(tx);
    // counted as Notifications shows them: one line per kind a day (ADR 035), from the unread
    // ones only, so an unread line older than the 50 newest still counts (ADR 169)
    const recent = await sql<NotificationRow>`
      select id, kind, title, null as body, link, read_at, created_at from ops.notification
       where owner_user_id = core.current_user_id() and read_at is null
       order by created_at desc, id desc limit 500`.execute(tx);
    // product roles only: a custom group's own code says nothing about the kind of work
    const groupSet = new Set(groups.rows.map((g) => g.access_group).filter(isProductCode));
    const flags = await cachedNavFlags(
      navFlagsKey(user.id, domainMap, modules, groupSet, home.rows[0]?.id ?? null),
      async () => {
        // RLS shows only the recipes they may read; menu places are where they see costs
        const menu = MENU_DOMAINS.some(has)
          ? await sql<{ v: boolean }>`
              select exists (select 1 from inv.recipe)
                  or exists (select 1 from menu.my_menu_places()) as v`.execute(tx)
          : null;
        const production =
          has('PRODUCTION') || has('PRODUCTION_TEAM')
            ? await sql<{ v: boolean }>`
                select exists (select 1 from core.screen_places('production')) as v`.execute(tx)
            : null;
        // the Breakfast tile follows the database's rule: front office and housekeeping (ROOMS),
        // and whoever works in a kitchen or restaurant of a hotel with rooms (ADR 094, 097)
        const breakfast = modules.has('rooms')
          ? await sql<{ v: boolean }>`
              select exists (select 1 from ops.breakfast_outlets()) as v`.execute(tx)
          : null;
        // Compliance for someone without the register: their department's licences and jobs
        const compliance =
          modules.has('compliance') && !has('COMPLIANCE')
            ? await sql<{ v: boolean }>`
                select ops.sees_department_compliance() as v`.execute(tx)
            : null;
        // frontline staff have only their own week; others ask rpt.my_reports() (ADR 023)
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
        // reading the roster of several places (HR) makes Roster a screen of theirs (ADR 150)
        const rosterWide =
          domainMap.get('ROSTER') === 'view'
            ? await sql<{ v: boolean }>`
                select (select count(*) from core.screen_places('roster')) > 1 as v`.execute(tx)
            : null;
        const checks = EMPTY_CHECKS.filter((c) => c.domains.some(has));
        const empty = checks.length
          ? (
              await sql<{ key: ScreenKey }>`
                select x.key from (values ${sql.join(
                  checks.map((c) => sql`(${c.key}, exists (select 1 from ${sql.raw(c.list)}))`),
                )}) as x(key, has) where not x.has`.execute(tx)
            ).rows.map((r) => r.key)
          : [];
        return {
          nothing: new Set(empty),
          menu: menu?.rows[0]?.v ?? false,
          production: production?.rows[0]?.v ?? false,
          reports,
          breakfast: breakfast?.rows[0]?.v ?? false,
          compliance: compliance?.rows[0]?.v ?? false,
          rosterWide: rosterWide?.rows[0]?.v ?? false,
        };
      },
    );
    return {
      user,
      domains: domainMap,
      modules,
      groups: groupSet,
      nodes: nodes.rows,
      tz,
      home: home.rows[0] ?? null,
      jobTitle: title.rows[0]?.name ?? null,
      inboxCount: inbox.rows[0]?.n ?? 0,
      unreadCount: unreadLines(recent.rows, tz),
      ...flags,
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
  return {
    ...navInput(shell),
    access: shell.domains,
    atWork: shell.home?.at_workplace ?? false,
    breakfast: shell.breakfast,
    compliance: shell.compliance,
    nothing: shell.nothing,
    rosterWide: shell.rosterWide,
  };
}
