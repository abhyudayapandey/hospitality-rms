import 'server-only';
import type { Cell } from './csv';
import { readRange, type DateRange } from './date-range';
import { registerDef } from '@outlet-ops/domain';
import { breakageLog } from './breakage';
import { complianceJobs, licences } from './compliance';
import { addDays } from './dates';
import { laundry } from './linen';
import { logbook } from './logbook';
import { registerEntries } from './registers';
import { isMeal, mealDay } from './rooms';
import { EXCEPTION_LABEL, exceptions, exceptionsAll, inRange } from './people';
import { teamTasks } from './tasks';
import { utilityDays } from './utilities';
import { BILL_TABS, billList, type BillTab } from './bill-list';
import { sql, type Tx } from './db';
import { PO_PROGRESS, TRANSFER_PROGRESS } from './inventory';
import { listDays } from './list-days';
import { minibarCharged, minibarUsage, usedWords } from './minibar';
import { ORDER_TABS, orderList, type OrderTab } from './order-list';
import { reportToday } from './report-data';
import { transferList } from './transfer-list';
import { wastageList } from './wastage-list';

// The lists' downloads (ADR 120): each reads through the same function as its screen, as the
// signed-in person, so a file holds exactly what the screen shows for the same days; a place the
// person may not open is refused there (NOT_AUTHORISED).

export interface Sheet {
  name: string;
  header: string[];
  rows: Cell[][];
}

type Run = (tx: Tx, q: URLSearchParams) => Promise<Sheet>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A place's id from the query, or a refusal. */
export function placeOf(q: URLSearchParams, key = 'outlet'): string {
  const v = q.get(key) ?? '';
  if (!UUID.test(v)) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  return v;
}

/** The days asked for, as the screen reads them. */
export async function daysOf(
  tx: Tx,
  q: URLSearchParams,
  node: string,
  days = 7,
): Promise<DateRange> {
  return readRange(
    { from: q.get('from') ?? undefined, to: q.get('to') ?? undefined },
    await reportToday(tx, node),
    days,
  );
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : '');

/** Every row of a list in a file, not a page of it. */
const ALL_ROWS = 20000;

/**
 * The store a stock list's download is for (?node=), one of the person's places on that screen,
 * and with ?all=1 every one of them, as the screen's "All stores".
 */
async function storesOf(
  tx: Tx,
  q: URLSearchParams,
  screen: string,
): Promise<{ node: string; nodes: string[] }> {
  const node = placeOf(q, 'node');
  const ids = (
    await sql<{ id: string }>`select id::text from core.screen_places(${screen})`.execute(tx)
  ).rows.map((r) => r.id);
  if (!ids.includes(node)) {
    throw Object.assign(new Error('NOT_AUTHORISED'), { code: 'NOT_AUTHORISED' });
  }
  return { node, nodes: q.get('all') === '1' && ids.length > 1 ? ids : [node] };
}

/** "all days" in a file name when no days were picked. */
const daysName = (r: DateRange | null) => (r ? `${r.from}-${r.to}` : 'all-days');

export const EXPORTS: Record<string, Run> = {
  minibar_charged: async (tx, q) => {
    const outlet = placeOf(q);
    const r = await daysOf(tx, q, outlet);
    return {
      name: `minibar-added-to-bills-${r.from}-${r.to}`,
      header: ['room', 'used', 'amount', 'checked_at', 'checked_by', 'added_at', 'added_by'],
      rows: (await minibarCharged(tx, outlet, r.from, r.to)).map((c) => [
        c.room,
        usedWords(c.used),
        c.charge,
        iso(c.checked_at),
        c.checked_by,
        iso(c.charged_at),
        c.charged_by,
      ]),
    };
  },
  minibar_usage: async (tx, q) => {
    const outlet = placeOf(q);
    const r = await daysOf(tx, q, outlet);
    return {
      name: `minibar-charged-to-guests-${r.from}-${r.to}`,
      header: ['item', 'unit', 'used', 'rooms', 'charged', 'cost', 'refilled'],
      rows: (await minibarUsage(tx, outlet, r.from, r.to)).map((u) => [
        u.item,
        u.unit,
        u.used,
        u.rooms,
        u.revenue,
        u.cost,
        u.refilled,
      ]),
    };
  },
  orders: async (tx, q) => {
    const { node, nodes } = await storesOf(tx, q, 'orders');
    const { range } = await listDays(tx, q, node);
    const t = q.get('tab') ?? 'all';
    const tab: OrderTab = (ORDER_TABS as readonly string[]).includes(t) ? (t as OrderTab) : 'all';
    const { rows } = await orderList(tx, { nodes, node, tab, limit: ALL_ROWS, range });
    return {
      name: `orders-${daysName(range)}`,
      header: [
        'placed_at',
        'store',
        'supplier',
        'items',
        'status',
        'due',
        'received_value',
        'bill',
      ],
      rows: rows.map((r) => [
        iso(r.created_at),
        r.store,
        r.supplier ?? 'Request to buy',
        r.items,
        PO_PROGRESS[r.progress]?.[0] ?? r.progress,
        r.expected_on,
        r.follow ? null : r.value,
        r.bill_missing ? 'missing' : '',
      ]),
    };
  },
  transfers: async (tx, q) => {
    const { node, nodes } = await storesOf(tx, q, 'transfers');
    const { range } = await listDays(tx, q, node);
    const tab = q.get('tab') === 'send' ? 'send' : 'all';
    const { rows } = await transferList(tx, { nodes, node, tab, limit: ALL_ROWS, range });
    return {
      name: `transfers-${daysName(range)}`,
      header: ['asked_at', 'from', 'to', 'items', 'status'],
      rows: rows.map((r) => [
        iso(r.created_at),
        r.from_name,
        r.to_name,
        r.items,
        TRANSFER_PROGRESS[r.progress]?.[0] ?? r.progress,
      ]),
    };
  },
  bills: async (tx, q) => {
    const { node, nodes } = await storesOf(tx, q, 'bills');
    const { range } = await listDays(tx, q, node);
    const t = q.get('tab') ?? 'all';
    const tab: BillTab = (BILL_TABS as readonly string[]).includes(t) ? (t as BillTab) : 'all';
    const r = await billList(tx, { nodes, node, tab, limit: ALL_ROWS, range });
    if (tab === 'waiting') {
      return {
        name: `orders-waiting-for-a-bill-${daysName(range)}`,
        header: ['ordered_at', 'store', 'supplier', 'received_value'],
        rows: r.waiting.map((w) => [iso(w.released_at), w.store, w.supplier, w.received]),
      };
    }
    return {
      name: `bills-${daysName(range)}`,
      header: ['bill_date', 'store', 'supplier', 'bill_no', 'kind', 'amount', 'description'],
      rows: r.bills.map((b) => [
        b.bill_day,
        b.store,
        b.supplier,
        b.bill_no,
        b.kind,
        b.amount,
        b.description,
      ]),
    };
  },
  wastage: async (tx, q) => {
    const { node } = await storesOf(tx, q, 'wastage');
    const { range } = await listDays(tx, q, node);
    return {
      name: `wastage-${daysName(range)}`,
      header: ['at', 'item', 'unit', 'qty', 'reason', 'value', 'status'],
      rows: (await wastageList(tx, node, range, ALL_ROWS)).map((r) => [
        iso(r.created_at),
        r.name,
        r.base_uom,
        r.qty,
        r.reason.replace(/_/g, ' '),
        r.value,
        r.outcome === 'approval' ? 'needs approval' : 'posted',
      ]),
    };
  },
  // a month's breakage log at a place (ADR 093)
  breakage: async (tx, q) => {
    const place = placeOf(q, 'place');
    const m = q.get('month') ?? '';
    if (!/^\d{4}-\d{2}-01$/.test(m)) {
      throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
    }
    return {
      name: `breakage-${m.slice(0, 7)}`,
      header: [
        'broken_at',
        'place',
        'store',
        'item',
        'unit',
        'qty',
        'reason',
        'who',
        'note',
        'value',
        'recorded_by',
      ],
      rows: (await breakageLog(tx, place, m)).map((e) => [
        e.broken_at,
        e.place,
        e.store,
        e.item,
        e.unit,
        e.qty,
        e.reason.replace(/_/g, ' '),
        e.person ?? e.broken_by,
        e.note,
        e.value,
        e.recorded_by,
      ]),
    };
  },
  registers: async (tx, q) => {
    const place = placeOf(q, 'place');
    const register = q.get('register') ?? '';
    const def = registerDef(register);
    if (!def) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
    const { range } = await listDays(tx, q, place);
    const rows = await registerEntries(tx, place, register, range);
    return {
      name: `${def.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${daysName(range)}`,
      header: [
        'written_at',
        'written_by',
        ...def.fields.map((f) => f.label),
        'status',
        'outcome',
        'note',
        'closed_at',
        'closed_by',
      ],
      rows: rows.map((e) => [
        iso(e.written_at),
        e.written_by,
        ...def.fields.map((f) => e.fields[f.key] ?? null),
        e.status,
        e.outcome,
        e.close_note,
        iso(e.closed_at),
        e.closed_by,
      ]),
    };
  },
  logbook: async (tx, q) => {
    const place = placeOf(q, 'place');
    const { range } = await listDays(tx, q, place);
    return {
      name: `logbook-${daysName(range)}`,
      header: ['written_at', 'written_by', 'kind', 'text', 'until', 'to', 'seen_at', 'seen_by'],
      rows: (await logbook(tx, place, range)).map((e) => [
        iso(e.written_at),
        e.written_by,
        e.kind,
        e.body,
        iso(e.valid_till),
        [e.to_who, e.to_place].filter(Boolean).join(' at '),
        iso(e.acknowledged_at),
        e.acknowledged_by,
      ]),
    };
  },
  utilities: async (tx, q) => {
    const place = placeOf(q, 'place');
    const { range } = await listDays(tx, q, place);
    return {
      name: `meter-readings-${daysName(range)}`,
      header: ['day', 'meter', 'kind', 'unit', 'reading', 'used'],
      rows: (await utilityDays(tx, place, 60, range)).map((d) => [
        d.day,
        d.meter,
        d.kind,
        d.unit,
        d.reading,
        d.used,
      ]),
    };
  },
  laundry: async (tx, q) => {
    const place = placeOf(q, 'place');
    const { range } = await listDays(tx, q, place);
    return {
      name: `laundry-${daysName(range)}`,
      header: ['day', 'item', 'sent', 'received', 'at_laundry'],
      rows: (await laundry(tx, place, range)).map((r) => [
        r.day,
        r.item,
        r.sent,
        r.received,
        r.at_laundry,
      ]),
    };
  },
  // a meal's rooms, day by day (ADR 121): at most 31 days
  meals: async (tx, q) => {
    const outlet = placeOf(q);
    const meal = q.get('meal') ?? 'breakfast';
    if (!isMeal(meal)) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
    const r = await daysOf(tx, q, outlet, 30);
    const rows: Cell[][] = [];
    for (let d = r.from, n = 0; d <= r.to && n < 31; d = addDays(d, 1), n++) {
      for (const m of await mealDay(tx, outlet, d, meal)) {
        if (m.room_list.length === 0 && m.total == null) continue;
        if (m.room_list.length === 0) rows.push([d, m.mode, null, m.total, null]);
        for (const x of m.room_list) rows.push([d, m.mode, x.number, x.guests, x.note]);
      }
    }
    return {
      name: `${meal}-${r.from}-${r.to}`,
      header: ['day', 'served', 'room', 'guests', 'note'],
      rows,
    };
  },
  // the team's tasks due on the days (ADR 020, 120); the last 7 days when none are picked
  team_tasks: async (tx, q) => {
    const node = placeOf(q, 'node');
    const r = await daysOf(tx, q, node, 7);
    return {
      name: `team-tasks-${r.from}-${r.to}`,
      header: [
        'due_at',
        'place',
        'task',
        'kind',
        'status',
        'who',
        'steps_done',
        'steps',
        'flagged',
        'overdue',
      ],
      rows: (await teamTasks(tx, node, r.from, r.to)).map((t) => [
        iso(t.due_at),
        t.place_name,
        t.title,
        t.kind,
        t.status,
        t.assignee_name ?? t.pool,
        t.steps_done,
        t.steps_total,
        t.flagged,
        t.overdue ? 'yes' : '',
      ]),
    };
  },
  attendance_exceptions: async (tx, q) => {
    const { node, nodes } = await storesOf(tx, q, 'exceptions');
    const { range } = await listDays(tx, q, node);
    const status = q.get('status') === 'closed' ? 'closed' : 'open';
    const rows = inRange(
      nodes.length > 1
        ? await exceptionsAll(tx, nodes, status)
        : await exceptions(tx, node, status),
      range,
    );
    return {
      name: `attendance-exceptions-${status}-${daysName(range)}`,
      header: ['day', 'place', 'person', 'what', 'status', 'note'],
      rows: rows.map((e) => [
        e.local_date,
        e.place_name,
        e.worker_name,
        EXCEPTION_LABEL[e.kind] ?? e.kind,
        e.status,
        e.resolution_note,
      ]),
    };
  },
  // every licence or every regular job (ADR 069, 073)
  compliance: async (tx, q) => {
    const { node, nodes } = await storesOf(tx, q, 'compliance');
    const at = nodes.length > 1 ? null : node;
    if (q.get('tab') === 'jobs') {
      return {
        name: 'regular-jobs',
        header: ['place', 'job', 'next_due', 'days_left', 'answers_for_it', 'does_it', 'last_done'],
        rows: (await complianceJobs(tx, at)).map((j) => [
          j.place_name,
          j.name,
          j.next_due,
          j.days_left,
          j.owner_role_name,
          j.doer_role_name,
          j.last_done,
        ]),
      };
    }
    return {
      name: 'licences',
      header: [
        'place',
        'licence',
        'number',
        'authority',
        'issued_on',
        'expires_on',
        'days_left',
        'renewed_by',
      ],
      rows: (await licences(tx, at)).map((l) => [
        l.place_name,
        l.name,
        l.number,
        l.authority,
        l.issued_on,
        l.expires_on,
        l.days_left,
        l.renewal_role_name,
      ]),
    };
  },
};
