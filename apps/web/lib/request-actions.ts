import { sql, type Tx } from './db';
import { handOnPeople, type Person } from './tasks';
import { levelsText, type RequestLevel } from './request-levels';

// One request, one screen (ADR 147): every button a person may use on a request between stores
// (approve or reject, send it, give the sending to someone, receive it, their own send or
// receive task) is worked out here once, and shown on whichever screen the request opens on:
// its own page, or the page of the ask it was made for.

export interface RequestLine {
  item_id: string;
  name: string;
  base_uom: string;
  requested_qty: string;
  dispatched_qty: string | null;
  received_qty: string | null;
  levels?: string;
}

export interface RequestActionData {
  transfer: string;
  wfRequest: string;
  /** the step the viewer may act on, decided in SQL (inv.my_transfer_step) */
  mode: 'dispatch' | 'receive' | 'approve' | null;
  gm: boolean;
  lines: RequestLine[];
  /** whoever may send it can give the sending to someone (ADR 115) */
  sendPeople: { id: string; name: string }[];
  givenTo: string | null;
  /** the viewer's own open send or receive task on it, done right here */
  task: {
    id: string;
    kind: 'send' | 'receive';
    canWork: boolean;
    canHandOn: boolean;
    department: string;
    sendLines: {
      item_id: string;
      name: string;
      base_uom: string;
      asked: string;
      at_store: string;
      sent: string | null;
    }[];
    sentLines: {
      item_id: string;
      name: string;
      base_uom: string;
      sent: string;
      received: string | null;
    }[];
    handOn: Person[];
  } | null;
}

export async function requestActions(tx: Tx, transfer: string): Promise<RequestActionData | null> {
  const t = (
    await sql<{ progress: string; wf_request_id: string; my_step: string | null }>`
      select progress, wf_request_id::text, inv.my_transfer_step(id) as my_step
        from inv.transfer_summary where id = ${transfer}::uuid`.execute(tx)
  ).rows[0];
  if (!t) return null;
  // lines the user may act on come through the step (a fallback approver may hold no
  // TRANSFERS rights there); otherwise as RLS allows
  const lines = t.my_step
    ? (await sql<RequestLine>`select * from inv.my_transfer_lines(${transfer}::uuid)`.execute(tx))
        .rows
    : (
        await sql<RequestLine>`
          select tl.item_id, i.name, i.base_uom, tl.requested_qty, tl.dispatched_qty,
                 tl.received_qty
            from inv.transfer_line tl join inv.item i on i.id = tl.item_id
           where tl.transfer_id = ${transfer}::uuid order by i.name`.execute(tx)
      ).rows;
  const act = (
    await sql<{ may_send: boolean; may_receive: boolean; given_to: string | null }>`
      select may_send, may_receive, given_to from inv.request_actions(${transfer}::uuid)`.execute(
      tx,
    )
  ).rows[0];
  const sendPeople = act?.may_send
    ? (
        await sql<{ id: string; name: string }>`
          select id::text, name from inv.send_people(${transfer}::uuid)`.execute(tx)
      ).rows
    : [];
  // what each store has, for whoever decides or sends it (ADR 141), until it is sent
  const levels = ['awaiting_approval', 'awaiting_dispatch'].includes(t.progress)
    ? (
        await sql<RequestLevel>`
          select item_id::text, name, base_uom, asked::text, from_name, from_on_hand::text,
                 to_name, to_on_hand::text, to_par::text
            from inv.request_levels(${transfer}::uuid)`.execute(tx)
      ).rows
    : [];
  const byItem = new Map(levels.map((l) => [l.item_id, levelsText(l)]));
  // the viewer's own open send or receive task on it (ADR 143), worked here, not elsewhere
  const mine = (
    await sql<{
      id: string;
      kind: 'send' | 'receive';
      can_work: boolean;
      can_hand_on: boolean;
      department: string;
      me: string;
    }>`
      select t.id::text, t.kind, core.current_user_id()::text as me,
             (d ->> 'can_work')::boolean as can_work,
             (d ->> 'can_hand_on')::boolean as can_hand_on,
             regexp_replace(d ->> 'place_name', '^.*\\s[–-]\\s', '') as department
        from ops.task t, ops.task_detail(t.id) d
       where t.transfer_id = ${transfer}::uuid and t.assignee_user_id = core.current_user_id()
         and t.kind in ('send', 'receive') and t.status in ('open', 'in_progress')
       limit 1`.execute(tx)
  ).rows[0];
  const task = mine
    ? {
        id: mine.id,
        kind: mine.kind,
        canWork: mine.can_work,
        canHandOn: mine.can_hand_on,
        department: mine.department,
        sendLines:
          mine.kind === 'send'
            ? (
                await sql<NonNullable<RequestActionData['task']>['sendLines'][number]>`
                  select item_id::text, name, base_uom, asked::text, at_store::text, sent::text
                    from ops.send_task_lines(${mine.id}::uuid)`.execute(tx)
              ).rows
            : [],
        sentLines:
          mine.kind === 'receive'
            ? (
                await sql<NonNullable<RequestActionData['task']>['sentLines'][number]>`
                  select item_id::text, name, base_uom, sent::text, received::text
                    from ops.sent_lines(${mine.id}::uuid)`.execute(tx)
              ).rows
            : [],
        handOn: mine.can_hand_on
          ? (await handOnPeople(tx, mine.id)).filter((p) => p.user_id !== mine.me)
          : [],
      }
    : null;
  return {
    transfer,
    wfRequest: t.wf_request_id,
    mode:
      t.my_step === 'dispatch'
        ? 'dispatch'
        : t.my_step === 'receipt' || act?.may_receive
          ? 'receive'
          : t.my_step === 'approval' || t.my_step === 'gm_approval'
            ? 'approve'
            : null,
    gm: t.my_step === 'gm_approval',
    lines: lines.map((l) => {
      const lv = byItem.get(l.item_id);
      return lv ? { ...l, levels: lv } : l;
    }),
    sendPeople,
    givenTo: act?.given_to ?? null,
    task,
  };
}
