import 'server-only';
import { sql, type Tx } from './db';
import { formatMoney, formatWhen, processLabel } from './format';
import { stepLabel } from './request-words';

// What waits for the person (wf.my_inbox): the Approvals screen lists all of it, and Home
// the first few with Approve and No where the decision belongs there (UX-6).

export interface InboxEntry {
  requestId: string;
  processType: string;
  processLabel: string;
  step: string;
  amount: string | null;
  waitingSince: string;
  from: string;
  /** module screen for this request (order, adjustment review, transfer) */
  link?: { href: string; label: string };
  /** show Approve/Reject here (false when the decision belongs on the module screen) */
  inline: boolean;
  /** why it needs approval, in plain words (an unusual order or request, ADR 044) */
  why?: string;
  /** what was asked for: "Test Onions 2 kg, Test Ghee 1 kg" (ADR 053) */
  items?: string;
  /** where it is, in plain words: "needs your approval", "to send" (ADR 053) */
  stepLabel: string;
}

/** One name for each kind of request (ADR 053). */
function kindLabel(processType: string, payload: Record<string, unknown>): string {
  if (processType === 'PURCHASE_ORDER') return 'Supply request';
  if (processType === 'TRANSFER')
    return payload.rfm === true ? 'Request for material' : 'Stock request';
  if (processType === 'DEACTIVATION' && typeof payload.person === 'string') {
    return `Deactivate ${payload.person}${typeof payload.reason === 'string' ? `: ${payload.reason}` : ''}`;
  }
  return processLabel(processType);
}

interface InboxRow {
  request_id: string;
  process_type: string;
  step: string;
  activated_at: Date;
  amount: string | null;
  payload: Record<string, unknown>;
  subject_id: string;
  delivery_node_id: string | null;
  approve_via: string | null;
  initiator_name: string;
}

/** Where a request is decided when not (only) from the inbox, and whether to show buttons. */
function moduleLink(r: InboxRow): Pick<InboxEntry, 'link' | 'inline'> {
  switch (r.process_type) {
    case 'PURCHASE_ORDER':
      return {
        link: {
          href: `/stock/orders/${r.subject_id}?node=${r.delivery_node_id}`,
          label: 'View order',
        },
        inline: true,
      };
    case 'STOCK_ADJUSTMENT':
      // photos and lines are on the review screen, so decide there
      return {
        link: { href: `/stock/adjustments/${r.subject_id}`, label: 'Review' },
        inline: false,
      };
    case 'TRANSFER': {
      // the department head's or GM's approval of a request for material (TR-3): decided here
      if (r.step === 'approval') {
        return {
          link: {
            href: `/stock/transfers/${r.subject_id}?node=${r.delivery_node_id}`,
            label: 'View request',
          },
          inline: true,
        };
      }
      const node = r.step === 'dispatch' ? String(r.payload.from_node_id) : r.delivery_node_id;
      return {
        link: {
          href: `/stock/transfers/${r.subject_id}?node=${node}`,
          label: r.step === 'dispatch' ? 'Open to send' : 'Open to receive',
        },
        inline: false,
      };
    }
    case 'LEAVE':
      // the balance and the shifts approval would drop are on the review screen
      return { link: { href: `/leave/${r.subject_id}`, label: 'Review' }, inline: false };
    case 'SHIFT_SWAP':
      // approved through hr.approve_swap, which re-checks the rostering rules
      return { link: { href: `/roster/swaps/${r.subject_id}`, label: 'Review' }, inline: false };
    default:
      return { inline: r.approve_via !== 'module' };
  }
}

export async function inboxEntries(tx: Tx): Promise<InboxEntry[]> {
  const r = await sql<InboxRow>`
    select request_id, process_type, step, activated_at, amount, payload, subject_id,
           delivery_node_id, approve_via, initiator_name
      from wf.my_inbox()`.execute(tx);
  // a supply request's items, so it is decided from what was asked for (ADR 053); RLS shows
  // the lines to whoever may approve the store's orders
  const pos = r.rows.filter((x) => x.process_type === 'PURCHASE_ORDER').map((x) => x.subject_id);
  const items = new Map(
    pos.length === 0
      ? []
      : (
          await sql<{ po: string; items: string }>`
            select pl.po_id::text as po,
                   string_agg(i.name || ' ' || trim(trailing '.' from trim(trailing '0' from pl.qty::text))
                              || ' ' || i.base_uom, ', ' order by i.name) as items
              from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
             where pl.po_id = any(${pos}::uuid[])
             group by pl.po_id`.execute(tx)
        ).rows.map((x) => [x.po, x.items]),
  );
  return r.rows.map((x) => ({
    requestId: x.request_id,
    processType: x.process_type,
    processLabel: kindLabel(x.process_type, x.payload),
    step: x.step,
    stepLabel: stepLabel(x.step),
    ...(typeof x.payload.why === 'string' && x.payload.why !== '' && x.step.endsWith('approval')
      ? { why: x.payload.why }
      : {}),
    ...(items.has(x.subject_id) ? { items: items.get(x.subject_id)! } : {}),
    // a supply request's money is the last price paid: an estimate (ADR 053)
    amount:
      x.amount === null
        ? null
        : x.process_type === 'PURCHASE_ORDER'
          ? `about ${formatMoney(x.amount)}`
          : formatMoney(x.amount),
    waitingSince: formatWhen(x.activated_at),
    // a discard sent in the lead's name for whoever threw the batch away (ADR 021)
    from:
      typeof x.payload.recorded_by_name === 'string'
        ? `${x.initiator_name} for ${x.payload.recorded_by_name}`
        : x.initiator_name,
    ...moduleLink(x),
  }));
}
