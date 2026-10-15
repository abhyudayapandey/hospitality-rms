import 'server-only';
import { sql, type Tx } from './db';
import type { IconName } from '@/components/icon';
import { listHref } from './stock-view';

// Office work on Home (ADR 151, P3): the accountant, HR and the auditor work at a desk, not on
// the floor, so their Home shows what waits at it. Each row is counted from what the person
// can already see (RLS, core.can, the functions that refuse otherwise); a row shows only for
// the access that does that job, so nobody gets someone else's desk.

export interface DeskRow {
  key: string;
  label: string;
  n: number;
  href: string;
  icon: IconName;
  /** said when there is nothing (n = 0) */
  none: string;
}

export interface DeskInput {
  groups: ReadonlySet<string>;
  domains: ReadonlyMap<string, string>;
}

/** The rows of the person's desk; none when they have no office job. */
export async function loadDesk(tx: Tx, i: DeskInput): Promise<DeskRow[]> {
  const rows: DeskRow[] = [];
  // the accountant: received orders without their bill, and what came in this week (ADR 109)
  if (i.groups.has('ACCOUNTS') && i.domains.has('BILLS')) {
    const r = (
      await sql<{ missing: number; received: number }>`
        select (select count(*) from inv.purchase_order_summary po
                 where po.received_qty > 0 and po.released_at > now() - interval '60 days'
                   and core.can('BILLS', 'view', null, po.delivery_node_id)
                   and not exists (select 1 from inv.bill b
                                    where b.po_id = po.id and b.archived_at is null))::int
                 as missing,
               (select count(distinct g.po_id) from inv.goods_receipt g
                  join inv.purchase_order po on po.id = g.po_id
                 where g.received_at > now() - interval '7 days'
                   and core.can('BILLS', 'view', null, po.delivery_node_id))::int as received`.execute(
        tx,
      )
    ).rows[0]!;
    rows.push(
      {
        key: 'bills-missing',
        label: 'Bills missing',
        n: r.missing,
        href: listHref('/stock/bills', { all: true, tab: 'waiting' }),
        icon: 'bill',
        none: 'every order has its bill',
      },
      {
        key: 'received',
        label: 'Received this week',
        n: r.received,
        href: listHref('/stock/orders', { all: true, tab: 'received' }),
        icon: 'truck',
        none: 'nothing came in',
      },
    );
  }
  // HR: clock-in problems to look at, and who joined in the last 30 days
  if (i.groups.has('OUTLET_HR')) {
    const r = (
      await sql<{ flags: number; joined: number }>`
        select (select count(*) from hr.attendance_exception x
                 where x.status = 'open'
                   and x.org_node_id in (select id from core.screen_places('exceptions')))::int
                 as flags,
               (select count(*) from hr.worker w
                 where w.status = 'active' and w.joined_on > current_date - 30
                   and w.joined_on <= current_date)::int as joined`.execute(tx)
    ).rows[0]!;
    rows.push(
      {
        key: 'exceptions',
        label: 'Clock-ins to check',
        n: r.flags,
        href: listHref('/roster/exceptions', { all: true }),
        icon: 'clock',
        none: 'nothing to check',
      },
      {
        key: 'joined',
        label: 'Joined this month',
        n: r.joined,
        href: '/team/people',
        icon: 'people',
        none: 'nobody new',
      },
    );
  }
  // the auditor: changes to who may do what, this week, across the company (AUDIT at the root
  // opens core.access_audit, ADR 153)
  if (i.groups.has('AUDITOR') && i.domains.has('AUDIT')) {
    const r = (
      await sql<{ n: number }>`
        select count(*)::int as n from core.access_audit(300)
         where occurred_at > now() - interval '7 days'`.execute(tx)
    ).rows[0]!;
    rows.push({
      key: 'access',
      label: 'Access changes this week',
      n: r.n,
      href: '/admin/audit',
      icon: 'shield',
      none: 'no changes',
    });
  }
  return rows;
}
