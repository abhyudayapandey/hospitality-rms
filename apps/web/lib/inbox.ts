import 'server-only';
import { sql, type Tx } from './db';
import { formatMoney, formatWhen, processLabel } from './format';

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
  return r.rows.map((x) => ({
    requestId: x.request_id,
    processType: x.process_type,
    processLabel: processLabel(x.process_type),
    step: x.step,
    amount: formatMoney(x.amount),
    waitingSince: formatWhen(x.activated_at),
    // a discard sent in the lead's name for whoever threw the batch away (ADR 021)
    from:
      typeof x.payload.recorded_by_name === 'string'
        ? `${x.initiator_name} for ${x.payload.recorded_by_name}`
        : x.initiator_name,
    ...moduleLink(x),
  }));
}
