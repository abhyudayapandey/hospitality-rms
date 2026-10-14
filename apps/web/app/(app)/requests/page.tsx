import Link from 'next/link';
import { Empty } from '@/components/messages';
import { PollRefresh } from '@/components/use-polling';
import { RfmTabs } from '@/components/rfm-tabs';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen, processLabel } from '@/lib/format';
import { isUuid, SUPPLY_PROGRESS } from '@/lib/inventory';
import { AskForm, type AskStoreItem } from '../stock/asks/new/ask-form';
import { RequestNow } from '../stock/transfers/[id]/request-story';

// RFMs, Requests for Materials (ADR 052, 142, 143): Ask is the form that asks the store one's
// team uses, through one's head; Previous asks is every request and every ask, newest first,
// each opening its page; Transfers (its own route) for whoever may see them. It opens on Ask
// for whoever has a store to ask.
// A supply request says where the order is and what is in it, never an estimate in ₹.

/** Where a request waits, in plain words: never a step's code. */
function waitingOn(step: string): string {
  if (step.endsWith('approval')) return 'waiting for approval';
  if (step === 'dispatch') return 'waiting to be sent';
  if (step === 'receive') return 'waiting to be received';
  return `waiting on ${step.replace(/_/g, ' ')}`;
}

const STATE_STYLE: Record<string, string> = {
  in_approval: 'bg-amber-100 text-amber-900',
  approved: 'bg-emerald-100 text-emerald-900',
  executing: 'bg-emerald-100 text-emerald-900',
  completed: 'bg-emerald-100 text-emerald-900',
  rejected: 'bg-rose-100 text-rose-900',
  cancelled: 'bg-slate-200 text-slate-700',
  failed: 'bg-rose-100 text-rose-900',
};

function subjectHref(r: {
  subject_type: string;
  subject_id: string;
  delivery_node_id: string | null;
}): string | null {
  const q = r.delivery_node_id ? `?node=${r.delivery_node_id}` : '';
  switch (r.subject_type) {
    case 'inv.purchase_order':
      return `/stock/orders/${r.subject_id}${q}`;
    case 'inv.transfer':
      return `/stock/transfers/${r.subject_id}${q}`;
    case 'inv.stock_adjustment':
      return `/stock/adjustments/${r.subject_id}`;
    case 'hr.leave_request':
      return `/leave/${r.subject_id}`;
    case 'hr.shift_swap':
      return `/roster/swaps/${r.subject_id}`;
    default:
      return null;
  }
}

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const user = await requireUser();
  // RLS on wf.request decides what is visible; this page lists the user's own requests.
  const { rows, asks, stores, store, items, transfers } = await withUser(user.id, async (tx) => {
    const r = await sql<{
      id: string;
      process_type: string;
      state: string;
      current_step: string | null;
      amount: string | null;
      created_at: Date;
      subject_type: string;
      subject_id: string;
      delivery_node_id: string | null;
      top_of_chain: boolean;
      /** a supply request: the order's progress and items (ADR 049, 052) */
      progress: string | null;
      items: string | null;
    }>`select r.id, r.process_type, r.state, r.current_step, r.amount, r.created_at,
              r.subject_type, r.subject_id, r.delivery_node_id,
              exists (select 1 from wf.step_instance s
                       where s.request_id = r.id and s.top_of_chain
                         and s.state = 'approved') as top_of_chain,
              po.progress,
              (select string_agg(i.name, ', ' order by i.name)
                 from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
                where pl.po_id = po.id) as items
         from wf.request r
         left join inv.purchase_order_summary po
                on r.subject_type = 'inv.purchase_order' and po.id = r.subject_id
        where r.initiator_id = core.current_user_id()
        order by r.created_at desc limit 50`.execute(tx);
    // asks to one's head (ADR 115): where they are now
    const a = await sql<{
      id: string;
      store: string;
      items: string;
      stage: string;
      words: string;
      created_at: Date;
    }>`select id::text, store, items, stage, words, created_at
         from inv.my_staff_asks(30)`.execute(tx);
    // the stores one's team uses, and what the chosen one keeps (ADR 115)
    const stores = (
      await sql<{ id: string; name: string }>`
        select id::text, name from inv.my_ask_stores()`.execute(tx)
    ).rows;
    const picked = typeof sp['store'] === 'string' && isUuid(sp['store']) ? sp['store'] : null;
    const store = stores.find((x) => x.id === picked) ?? stores[0] ?? null;
    const items = store
      ? (
          await sql<AskStoreItem>`
            select item_id::text, name, base_uom, on_hand::text
              from inv.ask_store_items(${store.id}::uuid)`.execute(tx)
        ).rows
      : [];
    // whoever may see the stores' transfers has them as a third tab (ADR 143)
    const transfers =
      (
        await sql<{ ok: boolean }>`
          select exists (select 1 from core.screen_places('transfers')) as ok`.execute(tx)
      ).rows[0]?.ok ?? false;
    return { rows: r.rows, asks: a.rows, stores, store, items, transfers };
  });
  const tab = sp['tab'] === 'ask' || sp['tab'] === 'asked' ? sp['tab'] : store ? 'ask' : 'asked';
  const card = 'block rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200';
  const list = [
    ...rows.map((r) => ({ at: new Date(r.created_at).getTime(), request: r, ask: null })),
    ...asks.map((a) => ({ at: new Date(a.created_at).getTime(), request: null, ask: a })),
  ].sort((x, y) => y.at - x.at);
  return (
    <div className="space-y-4">
      <RfmTabs current={tab} transfers={transfers} />
      {tab === 'ask' ? (
        store ? (
          <AskForm stores={stores} store={store} items={items} />
        ) : (
          <Empty icon="box">
            Your team has no store to ask. Managers ask from Stock, then Ask for stock.
          </Empty>
        )
      ) : list.length === 0 ? (
        <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
          Nothing asked for yet.
        </p>
      ) : (
        <ul className="space-y-3" data-testid="my-asks">
          {list.map((x) => {
            if (x.ask) {
              const a = x.ask;
              return (
                <li key={a.id} data-testid="ask-item">
                  <Link href={`/stock/asks/${a.id}`} className={`${card} space-y-2`}>
                    <span className="block font-medium">{a.items}</span>
                    <span className="block text-sm text-slate-600">
                      {a.store} · {formatWhen(a.created_at)}
                    </span>
                    <RequestNow stage={a.stage} words={a.words} />
                  </Link>
                </li>
              );
            }
            const r = x.request;
            const href = subjectHref(r);
            const supply = r.progress !== null;
            const [state, style] = supply
              ? (SUPPLY_PROGRESS[r.progress!] ?? [r.progress!, ''])
              : [r.state.replace(/_/g, ' '), STATE_STYLE[r.state] ?? ''];
            const body = (
              <>
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {supply ? 'Supply request' : processLabel(r.process_type)}
                  </span>
                  <span
                    data-testid="request-state"
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}
                  >
                    {state}
                  </span>
                </span>
                {r.items && (
                  <span className="mt-1 block truncate text-sm text-slate-700">{r.items}</span>
                )}
                {r.top_of_chain && !supply && (
                  <span className="block text-sm text-slate-600" data-testid="top-of-chain">
                    Approved at once: nobody above you approves this.
                  </span>
                )}
                <span className="block text-sm text-slate-600">
                  {!supply && r.current_step ? `${waitingOn(r.current_step)} · ` : ''}
                  {formatWhen(r.created_at)}
                </span>
              </>
            );
            return (
              <li key={r.id} data-testid="request-item" data-request-id={r.id}>
                {href ? (
                  <Link href={href} className={card}>
                    {body}
                  </Link>
                ) : (
                  <div className={card}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {tab === 'asked' && <PollRefresh />}
    </div>
  );
}
