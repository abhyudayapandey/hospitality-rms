import Link from 'next/link';
import { Empty } from '@/components/messages';
import { PollRefresh } from '@/components/use-polling';
import { RfmTabs } from '@/components/rfm-tabs';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { isUuid, SUPPLY_PROGRESS } from '@/lib/inventory';
import { rfmRequestHref } from '@/lib/rfm';
import { AskForm, type AskStoreItem } from '../stock/asks/new/ask-form';
import { RequestNow } from '../stock/transfers/[id]/request-story';

// RFMs, Request for Materials (ADR 143, 144): Request is the form that asks the store one's team uses,
// through one's head; Transfer (its own route) is the stores' transfers, for whoever may see
// them; History is what the person asked for: their asks, and the stock and supply requests
// they made, newest first, each opening its page. Leave and other requests are not materials: they are
// under Shifts & leave. It opens on Ask for whoever has a store to ask.

interface AskRow {
  id: string;
  store: string;
  items: string;
  stage: string;
  words: string;
  created_at: Date;
}

interface SupplyRow {
  id: string;
  po: string;
  node: string | null;
  created_at: Date;
  progress: string;
  items: string | null;
}

interface RequestRow {
  id: string;
  transfer: string;
  node: string | null;
  created_at: Date;
  items: string | null;
  for_ask: string | null;
  stage: string;
  words: string;
}

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
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
            select item_id::text, name, base_uom, on_hand::text, category, par::text
              from inv.ask_store_items(${store.id}::uuid)`.execute(tx)
        ).rows
      : [];
    // the note's example follows the outlet: a room at a hotel, a table elsewhere (ADR 153)
    const hotel =
      (await sql<{ f: string | null }>`select core.my_outlet_format() as f`.execute(tx)).rows[0]
        ?.f === 'hotel';
    // whoever may see the stores' transfers has them as a tab (ADR 143)
    const transfers =
      (
        await sql<{ ok: boolean }>`
          select exists (select 1 from core.screen_places('transfers')) as ok`.execute(tx)
      ).rows[0]?.ok ?? false;
    // asks to one's head (ADR 115), where they are now
    const asks = (
      await sql<AskRow>`
        select id::text, store, items, stage, words, created_at
          from inv.my_staff_asks(30)`.execute(tx)
    ).rows;
    // the stock requests one made (RLS on wf.request shows one's own): what was asked, who
    // for, and where it is now, in the words its own page uses (ADR 142)
    const requests = (
      await sql<RequestRow>`
        select r.id::text, r.subject_id::text as transfer, r.delivery_node_id::text as node,
               r.created_at,
               (select string_agg(trim(trailing '.' from trim(trailing '0' from
                                    tl.requested_qty::text)) || ' × ' || i.name,
                                  ', ' order by i.name)
                  from inv.transfer_line tl join inv.item i on i.id = tl.item_id
                 where tl.transfer_id = r.subject_id) as items,
               (select a.asked_by || coalesce(': ' || a.note, '')
                  from inv.request_for_ask(r.subject_id) a) as for_ask,
               n.stage, n.words
          from wf.request r
          cross join lateral inv.request_now(r.subject_id) n
         where r.initiator_id = core.current_user_id()
           and r.subject_type = 'inv.transfer'
         order by r.created_at desc limit 30`.execute(tx)
    ).rows;
    // supply requests one made (ADR 049, 052): what is in it and where the order is, no ₹
    const supplies = (
      await sql<SupplyRow>`
        select r.id::text, po.id::text as po, r.delivery_node_id::text as node, r.created_at,
               po.progress,
               (select string_agg(i.name, ', ' order by i.name)
                  from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
                 where pl.po_id = po.id) as items
          from wf.request r
          join inv.purchase_order_summary po on po.id = r.subject_id
         where r.initiator_id = core.current_user_id()
           and r.subject_type = 'inv.purchase_order'
         order by r.created_at desc limit 30`.execute(tx)
    ).rows;
    return {
      stores,
      store,
      items,
      hotel,
      transfers,
      asks,
      requests,
      supplies,
      request: await rfmRequestHref(tx),
    };
  });
  const { stores, store, items, hotel, transfers, asks, requests, supplies, request } = data;
  const asked = sp['tab'];
  const tab =
    (asked === 'ask' && store) || asked === 'history'
      ? asked
      : asked === 'asked'
        ? 'history'
        : store
          ? 'ask'
          : 'history';
  const card = 'block space-y-2 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200';
  const history = [
    ...asks.map((a) => ({
      at: new Date(a.created_at).getTime(),
      ask: a,
      request: null,
      supply: null,
    })),
    ...requests.map((r) => ({
      at: new Date(r.created_at).getTime(),
      ask: null,
      request: r,
      supply: null,
    })),
    ...supplies.map((p) => ({
      at: new Date(p.created_at).getTime(),
      ask: null,
      request: null,
      supply: p,
    })),
  ].sort((x, y) => y.at - x.at);
  return (
    <div className="space-y-4">
      <RfmTabs current={tab} transfers={transfers} request={request} />
      {tab === 'ask' && store ? (
        <AskForm stores={stores} store={store} items={items} hotel={hotel} />
      ) : history.length === 0 ? (
        <Empty icon="box">Nothing asked for yet.</Empty>
      ) : (
        <ul className="space-y-3" data-testid="rfm-history">
          {history.map(({ ask: a, request: r, supply: p }) =>
            a ? (
              <li key={a.id} data-testid="ask-item">
                <Link href={`/stock/asks/${a.id}`} className={card}>
                  <span className="block font-medium">Request to the {a.store}</span>
                  <span className="block text-sm text-slate-700">{a.items}</span>
                  <span className="block text-sm text-slate-600">{formatWhen(a.created_at)}</span>
                  <RequestNow stage={a.stage} words={a.words} />
                </Link>
              </li>
            ) : r ? (
              <li key={r.id} data-testid="request-item" data-request-id={r.id}>
                <Link
                  href={`/stock/transfers/${r.transfer}${r.node ? `?node=${r.node}` : ''}`}
                  className={card}
                >
                  <span className="block font-medium">
                    {r.for_ask ? `Request for ${r.for_ask}` : 'Request'}
                  </span>
                  {r.items && (
                    <span className="block text-sm text-slate-700" data-testid="request-items">
                      {r.items}
                    </span>
                  )}
                  <span className="block text-sm text-slate-600">{formatWhen(r.created_at)}</span>
                  <RequestNow stage={r.stage} words={r.words} />
                </Link>
              </li>
            ) : p ? (
              <li key={p.id} data-testid="request-item" data-request-id={p.id}>
                <Link
                  href={`/stock/orders/${p.po}${p.node ? `?node=${p.node}` : ''}`}
                  className={card}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">Request to buy</span>
                    <span
                      data-testid="request-state"
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${SUPPLY_PROGRESS[p.progress]?.[1] ?? ''}`}
                    >
                      {SUPPLY_PROGRESS[p.progress]?.[0] ?? p.progress.replace(/_/g, ' ')}
                    </span>
                  </span>
                  {p.items && (
                    <span className="block truncate text-sm text-slate-700">{p.items}</span>
                  )}
                  <span className="block text-sm text-slate-600">{formatWhen(p.created_at)}</span>
                </Link>
              </li>
            ) : null,
          )}
        </ul>
      )}
      {tab === 'history' && <PollRefresh />}
    </div>
  );
}
