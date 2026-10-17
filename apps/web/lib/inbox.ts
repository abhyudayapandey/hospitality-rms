import 'server-only';
import { sql, type Tx } from './db';
import { formatMoney, formatWhen, processLabel } from './format';
import { levelsText, twoDecimals, type RequestLevel } from './request-levels';
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
  /** a request made for a frontline ask: "For Sana Shaikh: Weekend party" (ADR 142) */
  forAsk?: string;
  /** a request between stores: per line, what each store has (ADR 141) */
  levels?: string[];
  /** where it is, in plain words: "needs your approval", "to send" (ADR 053) */
  stepLabel: string;
}

/** One name for each kind of request: what people ask for is a Request (ADR 053, 144). */
function kindLabel(processType: string, payload: Record<string, unknown>): string {
  if (processType === 'PURCHASE_ORDER') return 'Request to buy';
  if (processType === 'TRANSFER') return 'Request';
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
      // the department head's or GM's approval (TR-3, ADR 115): decided here, never "Open to
      // receive" (ADR 145)
      if (r.step === 'approval' || r.step === 'gm_approval') {
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
          label:
            r.step === 'dispatch'
              ? 'Open to send'
              : r.step === 'receipt'
                ? 'Open to receive'
                : 'Open',
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

/**
 * What waits for the person. `detailsFor`: only the first so many get a transfer's ask and
 * stock levels (Home shows 3); the rest are counted and labelled without them.
 */
export async function inboxEntries(
  tx: Tx,
  tz: string,
  opts: { detailsFor?: number } = {},
): Promise<InboxEntry[]> {
  const r = await sql<InboxRow>`
    select request_id, process_type, step, activated_at, amount, payload, subject_id,
           delivery_node_id, approve_via, initiator_name
      from wf.my_inbox()`.execute(tx);
  const shown = r.rows.slice(0, opts.detailsFor ?? r.rows.length);
  // a supply request's items, so it is decided from what was asked for (ADR 053); RLS shows
  // the lines to whoever may approve the store's orders
  const pos = shown.filter((x) => x.process_type === 'PURCHASE_ORDER').map((x) => x.subject_id);
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
  // at every step, the frontline ask behind a request between stores: who asked, and why
  // (ADR 142); one query for all of them (ADR 169)
  const transfers = shown.filter((x) => x.process_type === 'TRANSFER').map((x) => x.subject_id);
  const forAsk = new Map(
    transfers.length === 0
      ? []
      : (
          await sql<{ subject: string; asked_by: string; note: string | null }>`
            select t.id::text as subject, a.asked_by, a.note
              from unnest(${transfers}::uuid[]) t(id)
              cross join lateral inv.request_for_ask(t.id) a`.execute(tx)
        ).rows.map((a) => [a.subject, `For ${a.asked_by}${a.note ? `: ${a.note}` : ''}`]),
  );
  // and, waiting for approval, what each store has, per line (ADR 141)
  const waiting = shown
    .filter((x) => x.process_type === 'TRANSFER' && x.step.endsWith('approval'))
    .map((x) => x.subject_id);
  const levels = new Map<string, string[]>();
  if (waiting.length > 0) {
    const rows = (
      await sql<RequestLevel & { subject: string }>`
        select t.id::text as subject, l.item_id::text, l.name, l.base_uom, l.asked::text,
               l.from_name, l.from_on_hand::text, l.to_name, l.to_on_hand::text, l.to_par::text
          from unnest(${waiting}::uuid[]) with ordinality t(id, n)
          cross join lateral inv.request_levels(t.id) with ordinality l
         order by t.n, l.ordinality`.execute(tx)
    ).rows;
    for (const l of rows) {
      levels.set(l.subject, [...(levels.get(l.subject) ?? []), `${l.name}: ${levelsText(l)}`]);
    }
  }
  return r.rows.map((x) => ({
    requestId: x.request_id,
    processType: x.process_type,
    processLabel: kindLabel(x.process_type, x.payload),
    step: x.step,
    stepLabel: stepLabel(x.step),
    ...(typeof x.payload.why === 'string' && x.payload.why !== '' && x.step.endsWith('approval')
      ? { why: twoDecimals(x.payload.why) }
      : {}),
    ...(levels.has(x.subject_id) ? { levels: levels.get(x.subject_id)! } : {}),
    ...(forAsk.has(x.subject_id) ? { forAsk: forAsk.get(x.subject_id)! } : {}),
    ...(items.has(x.subject_id) ? { items: items.get(x.subject_id)! } : {}),
    // a supply request's money is the last price paid: an estimate (ADR 053)
    amount:
      x.amount === null
        ? null
        : x.process_type === 'PURCHASE_ORDER'
          ? `about ${formatMoney(x.amount)}`
          : formatMoney(x.amount),
    waitingSince: formatWhen(x.activated_at, tz),
    // a discard sent in the lead's name for whoever threw the batch away (ADR 021)
    from:
      typeof x.payload.recorded_by_name === 'string'
        ? `${x.initiator_name} for ${x.payload.recorded_by_name}`
        : x.initiator_name,
    ...moduleLink(x),
  }));
}
