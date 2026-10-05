import 'server-only';
import { addDays, localToday, weekStart } from './dates';
import { sql, withUser } from './db';
import { inboxEntries, type InboxEntry } from './inbox';
import { expiryList } from './inventory';
import { navProfile, type NavProfile } from './nav';
import { myShifts, openPunch, type MyShift, type OpenPunch } from './people';
import { myPushToday, posImportOf, posPlaces, type PushDish } from './pos-import';
import {
  departmentDay,
  departmentPeople,
  league,
  outletFlash,
  reportPlaces,
  reportToday,
} from './report-data';
import type { LeagueRow, MeasureRow } from './reports';
import type { TargetKey } from './settings';
import { companySettings } from './settings-data';
import type { Shell } from './shell';
import { myTasks, toAssign, type MyTask } from './tasks';
import { listHref } from './stock-view';
import {
  attentionGroups,
  currentShift,
  type AttentionCount,
  type AttentionGroup,
  type PlaceDepartment,
} from './today-view';

// What went out of a store over the last 14 days, and whether an item is low (lib/low-stock.ts):
// none left, or below its level and lasting three days or fewer at that rate.
const LOW_USE = sql`
  select -sum(l.qty) as used from inv.stock_ledger l
   where l.item_id = n.item_id and l.delivery_node_id = n.delivery_node_id
     and l.qty < 0 and l.movement_type <> 'count_adjust'
     and l.occurred_at > now() - interval '14 days'`;
const IS_LOW = sql`(coalesce(s.on_hand, 0) <= 0
  or (coalesce(s.on_hand, 0) < n.par_level and u.used > 0
      and coalesce(s.on_hand, 0) * 14 / u.used <= 3))`;

// What Home's "Today" cards show (UX-2), read in one transaction. Each read is an existing
// function or table under RLS; the cards are chosen by what the person can see, never by
// a permission check here (rule 2).

export interface TodayNumbers {
  report: 'outlet_flash' | 'department';
  place: { id: string; name: string };
  rows: MeasureRow[];
  /** department: people rostered now who haven't clocked in */
  notIn?: number;
}

/** The store keeper's four jobs (UX-6): what waits at the stores they keep. */
export interface StoreWork {
  /** orders sent to suppliers, not yet received in full */
  receive: number;
  /** transfers waiting to be sent from their stores */
  issue: number;
  /** items that run out within three days (lib/low-stock.ts) */
  low: number;
}

/** Expired and expiring batches at all the stores they see; the banners open them with
 * "All stores" chosen (ADR 038). */
export interface ExpiryCounts {
  expiring: { n: number };
  expired: { n: number };
}

/** The cashier's end-of-day job (SAL-2, ADR 039): has today's POS file been imported? */
export interface PosToday {
  outlet: { id: string; name: string };
  day: string;
  last: { at: string; posted: number; unmatched: number } | null;
}

export interface TodayLeague {
  place: { id: string; name: string };
  from: string;
  to: string;
  rows: LeagueRow[];
}

export interface Today {
  profile: NavProfile;
  shift: MyShift | null;
  punch: OpenPunch | null;
  tasks: MyTask[];
  /** the first few requests waiting for them, and how many in all */
  approvals: { shown: InboxEntry[]; total: number; toAssign: number };
  attention: AttentionGroup[] | null;
  /** the roster for all departments, on the earliest day with an open slot (null if none) */
  openSlotsHref: string | null;
  numbers: TodayNumbers | null;
  league: TodayLeague | null;
  store: StoreWork | null;
  expiry: ExpiryCounts | null;
  pos: PosToday | null;
  /** dishes to sell first today at their outlet (INV-12, ADR 040) */
  push: PushDish[];
  targets: Record<TargetKey, number>;
}

/** Approvals shown on Home; the rest are one tap away. */
export const HOME_APPROVALS = 3;

export async function loadToday(shell: Shell, tz: string): Promise<Today> {
  const profile = navProfile(shell.groups);
  const lead = profile !== 'frontline';
  const atWork = shell.home?.at_workplace ?? false;
  return withUser(shell.user.id, async (tx) => {
    const now = new Date();
    const today = localToday(tz, now);
    const shifts =
      atWork && shell.domains.has('ROSTER') ? await myShifts(tx, addDays(today, -1), 2) : [];
    const punch = atWork ? await openPunch(tx) : null;
    const tasks = shell.domains.has('TASKS') ? await myTasks(tx) : [];
    const inbox = await inboxEntries(tx);
    // expired items waiting to be given to someone; repairs waiting are the repairs count
    const assign = lead ? (await toAssign(tx)).filter((x) => x.kind === 'expiry').length : 0;

    let attention: AttentionGroup[] | null = null;
    let openSlotsHref: string | null = null;
    if (lead) {
      // each count at its place, under RLS; then the places' departments and order (DB-2)
      const counts = await sql<AttentionCount>`
        select 'lowStock' as kind, n.delivery_node_id::text as node, count(*)::int as n,
               null as href
          from inv.item_node n
          join inv.item i on i.id = n.item_id and i.archived_at is null
          left join inv.stock_level s on s.item_id = n.item_id
                                     and s.delivery_node_id = n.delivery_node_id
          left join lateral (${LOW_USE}) u on true
         where n.archived_at is null and n.par_level > 0 and ${IS_LOW}
         group by n.delivery_node_id
        union all
        select 'flags', x.org_node_id::text, count(*)::int, null
          from hr.attendance_exception x
         where x.status = 'open'
           and x.org_node_id in (select id from core.screen_places('exceptions'))
         group by x.org_node_id
        union all
        select 'repairs', m.place_node_id::text, count(*)::int, null
          from ops.maintenance_requests() m
         where m.status = 'open'
           and (select "on" from core.my_modules() where code = 'maintenance')
           and core.can('MAINTENANCE', 'modify', m.org_node_id, null)
         group by m.place_node_id`.execute(tx);
      // open slots in shifts that haven't started, the next seven days, where they build the
      // roster (ROSTER modify there, checked by core.can; RLS shows the shifts)
      const slots =
        shell.domains.get('ROSTER') === 'modify'
          ? await sql<{ node: string; n: number; day: string }>`
            with open as (
              select s.org_node_id, s.local_date,
                     s.headcount - (select count(*) from hr.shift_assignment x
                                     where x.shift_id = s.id and x.status = 'assigned') as gap
                from hr.shift s
               where s.status <> 'cancelled' and s.start_at > now()
                 and s.start_at < now() + interval '7 days'
                 and core.can('ROSTER', 'modify', s.org_node_id, null))
            select org_node_id::text as node, sum(gap)::int as n, min(local_date)::text as day
              from open where gap > 0
             group by org_node_id`.execute(tx)
          : null;
      const earliest = (slots?.rows ?? []).map((x) => x.day).sort()[0];
      if (earliest) {
        openSlotsHref = listHref('/roster/week', {
          all: true,
          week: weekStart(earliest),
          day: earliest,
        });
      }
      const all: AttentionCount[] = [
        ...counts.rows,
        ...(slots?.rows ?? []).map((s) => ({
          kind: 'openSlots' as const,
          node: s.node,
          n: s.n,
          href: `/roster/week?node=${s.node}&week=${weekStart(s.day)}&day=${s.day}`,
        })),
      ];
      const nodes = [...new Set(all.map((c) => c.node))];
      const places =
        nodes.length > 0
          ? (
              await sql<PlaceDepartment>`
                select node_id::text, department_id::text, department, rank, outlet_id::text,
                       outlet
                  from core.department_of(${nodes}::uuid[])`.execute(tx)
            ).rows
          : [];
      attention = attentionGroups(all, places);
    }

    // the store keeper's tiles (UX-6): the stores they see, under RLS
    let store: StoreWork | null = null;
    if (profile === 'store' && shell.domains.has('STOCK_LEVELS')) {
      const r = await sql<{ receive: number; low: number }>`
        select (select count(*) from inv.purchase_order_summary
                 where progress in ('released', 'partially_received'))::int as receive,
               (select count(*)
                  from inv.item_node n
                  join inv.item i on i.id = n.item_id and i.archived_at is null
                  left join inv.stock_level s on s.item_id = n.item_id
                                             and s.delivery_node_id = n.delivery_node_id
                  left join lateral (${LOW_USE}) u on true
                 where n.archived_at is null and n.par_level > 0 and ${IS_LOW})::int as low`.execute(
        tx,
      );
      store = {
        receive: r.rows[0]?.receive ?? 0,
        low: r.rows[0]?.low ?? 0,
        issue: inbox.filter((e) => e.processType === 'TRANSFER' && e.step === 'dispatch').length,
      };
    }

    // expired and expiring batches (INV-12) for leads who see stock
    let expiry: ExpiryCounts | null = null;
    if (lead && shell.domains.has('STOCK_LEVELS')) {
      const rows = await expiryList(tx);
      const n = (expired: boolean) => rows.filter((x) => x.expired === expired).length;
      expiry = { expiring: { n: n(false) }, expired: { n: n(true) } };
    }

    // the cashier's import (frontline people who import; managers import from Sales)
    let pos: PosToday | null = null;
    if (!lead && shell.domains.get('POS_IMPORT') === 'modify') {
      const o = (await posPlaces(tx))[0];
      if (o) {
        const day = await reportToday(tx, o.outlet_id);
        const last = await posImportOf(tx, o.outlet_id, day);
        pos = {
          outlet: { id: o.outlet_id, name: o.outlet_name },
          day,
          last: last
            ? { at: last.imported_at, posted: last.posted, unmatched: last.unmatched.length }
            : null,
        };
      }
    }
    // Push today: the function decides who sees it (service teams and the outlet's managers)
    const push = atWork ? await myPushToday(tx) : [];

    let numbers: TodayNumbers | null = null;
    let leagueTable: TodayLeague | null = null;
    if (shell.reports === 'business') {
      // outlets side by side for those over two or more (R-4): the area manager, the owner
      const lp = (await reportPlaces(tx, 'league'))[0];
      if (lp) {
        const to = await reportToday(tx, lp.id);
        const from = addDays(to, -6);
        const rows = await league(tx, lp.id, from, to);
        if (rows.length > 1) leagueTable = { place: lp, from, to, rows };
      }
    }
    if (shell.reports === 'business' && !leagueTable) {
      const outlets = await reportPlaces(tx, 'outlet_flash');
      const o = outlets[0];
      if (o) {
        const day = await reportToday(tx, o.id);
        numbers = { report: 'outlet_flash', place: o, rows: await outletFlash(tx, o.id, day) };
      } else {
        const d = (await reportPlaces(tx, 'department'))[0];
        if (d) {
          const day = await reportToday(tx, d.id);
          const people = await departmentPeople(tx, d.id);
          numbers = {
            report: 'department',
            place: d,
            rows: await departmentDay(tx, d.id, day),
            notIn: people.filter((p) => !p.clocked_in_at && new Date(p.start_at) <= now).length,
          };
        }
      }
    }
    return {
      profile,
      shift: currentShift(shifts, now),
      punch,
      tasks,
      approvals: { shown: inbox.slice(0, HOME_APPROVALS), total: inbox.length, toAssign: assign },
      attention,
      openSlotsHref,
      numbers,
      league: leagueTable,
      store,
      expiry,
      pos,
      push,
      targets: (await companySettings(tx)).targets,
    };
  });
}
