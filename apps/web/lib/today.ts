import 'server-only';
import { addDays, localToday } from './dates';
import { sql, withUser } from './db';
import { navProfile } from './nav';
import { myShifts, openPunch, type MyShift, type OpenPunch } from './people';
import {
  departmentDay,
  departmentPeople,
  outletFlash,
  reportPlaces,
  reportToday,
} from './report-data';
import type { MeasureRow } from './reports';
import type { Shell } from './shell';
import { myTasks, type MyTask } from './tasks';
import { currentShift, type Attention } from './today-view';

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

export interface Today {
  shift: MyShift | null;
  punch: OpenPunch | null;
  tasks: MyTask[];
  attention: Attention | null;
  numbers: TodayNumbers | null;
}

export async function loadToday(shell: Shell, tz: string): Promise<Today> {
  const lead = navProfile(shell.groups) !== 'frontline';
  const atWork = shell.home?.at_workplace ?? false;
  return withUser(shell.user.id, async (tx) => {
    const now = new Date();
    const today = localToday(tz, now);
    const shifts =
      atWork && shell.domains.has('ROSTER') ? await myShifts(tx, addDays(today, -1), 2) : [];
    const punch = atWork ? await openPunch(tx) : null;
    const tasks = shell.domains.has('TASKS') ? await myTasks(tx) : [];

    let attention: Attention | null = null;
    if (lead) {
      const a = await sql<Attention>`
        select
          (select count(*) from inv.item_node n
             join inv.item i on i.id = n.item_id and i.archived_at is null
             left join inv.stock_level s on s.item_id = n.item_id
                                        and s.delivery_node_id = n.delivery_node_id
            where n.archived_at is null and n.par_level > 0
              and coalesce(s.on_hand, 0) < n.par_level)::int as "belowPar",
          (select count(*) from hr.attendance_exception x
            where x.status = 'open'
              and x.org_node_id in (select id from core.screen_places('exceptions')))::int as flags,
          (select count(*) from ops.maintenance_requests() m
            where m.status in ('open', 'assigned', 'in_progress')
              and exists (select 1 from core.screen_places('maintenance') p
                           where p.id = m.org_node_id))::int as repairs`.execute(tx);
      attention = a.rows[0] ?? null;
    }

    let numbers: TodayNumbers | null = null;
    if (shell.reports === 'business') {
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
    return { shift: currentShift(shifts, now), punch, tasks, attention, numbers };
  });
}
