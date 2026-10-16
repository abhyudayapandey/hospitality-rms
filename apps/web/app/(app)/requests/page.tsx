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
// them; History is every request the person took part in (ADR 163): asks they made or were
// asked to give, requests and orders they made, approved, sent, received or placed, newest
// first, each opening its page, with who asked when it was not them. Leave and other requests are not materials: they are
// under Shifts & leave. It opens on Ask for whoever has a store to ask.

// One row of History (ADR 163): an ask, a request to a store or an order the person took part in.
interface HistoryRow {
  kind: 'ask' | 'request' | 'supply';
  id: string;
  page_id: string;
  node: string | null;
  created_at: Date;
  asked_by: string;
  mine: boolean;
  store: string | null;
  items: string | null;
  stage: string | null;
  words: string | null;
  progress: string | null;
  for_ask: string | null;
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
    // every request the person took part in, newest first (ADR 163)
    const history = (
      await sql<HistoryRow>`
        select kind, id::text, page_id::text, node::text, created_at, asked_by, mine, store,
               items, stage, words, progress, for_ask
          from inv.my_material_history(50)`.execute(tx)
    ).rows;
    return {
      stores,
      store,
      items,
      hotel,
      transfers,
      history,
      request: await rfmRequestHref(tx),
    };
  });
  const { stores, store, items, hotel, transfers, history, request } = data;
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
  // who asked, when it was not the reader (ADR 163)
  const by = (h: HistoryRow) =>
    h.mine ? null : (
      <span className="block text-sm text-slate-600" data-testid="asked-by">
        Asked by {h.asked_by}
      </span>
    );
  return (
    <div className="space-y-4">
      <RfmTabs current={tab} transfers={transfers} request={request} />
      {tab === 'ask' && store ? (
        <AskForm stores={stores} store={store} items={items} hotel={hotel} />
      ) : history.length === 0 ? (
        <Empty icon="box">Nothing asked for yet.</Empty>
      ) : (
        <ul className="space-y-3" data-testid="rfm-history">
          {history.map((h) =>
            h.kind === 'ask' ? (
              <li key={h.id} data-testid="ask-item">
                <Link href={`/stock/asks/${h.id}`} className={card}>
                  <span className="block font-medium">Request to the {h.store}</span>
                  <span className="block text-sm text-slate-700">{h.items}</span>
                  {by(h)}
                  <span className="block text-sm text-slate-600">{formatWhen(h.created_at)}</span>
                  <RequestNow stage={h.stage ?? ''} words={h.words ?? ''} />
                </Link>
              </li>
            ) : h.kind === 'request' ? (
              <li key={h.id} data-testid="request-item" data-request-id={h.id}>
                <Link
                  href={`/stock/transfers/${h.page_id}${h.node ? `?node=${h.node}` : ''}`}
                  className={card}
                >
                  <span className="block font-medium">
                    {h.for_ask ? `Request for ${h.for_ask}` : 'Request'}
                  </span>
                  {h.items && (
                    <span className="block text-sm text-slate-700" data-testid="request-items">
                      {h.items}
                    </span>
                  )}
                  {by(h)}
                  <span className="block text-sm text-slate-600">{formatWhen(h.created_at)}</span>
                  <RequestNow stage={h.stage ?? ''} words={h.words ?? ''} />
                </Link>
              </li>
            ) : (
              <li key={h.id} data-testid="request-item" data-request-id={h.id}>
                <Link
                  href={`/stock/orders/${h.page_id}${h.node ? `?node=${h.node}` : ''}`}
                  className={card}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">Request to buy</span>
                    {h.progress && (
                      <span
                        data-testid="request-state"
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${SUPPLY_PROGRESS[h.progress]?.[1] ?? ''}`}
                      >
                        {SUPPLY_PROGRESS[h.progress]?.[0] ?? h.progress.replace(/_/g, ' ')}
                      </span>
                    )}
                  </span>
                  {h.items && (
                    <span className="block truncate text-sm text-slate-700">{h.items}</span>
                  )}
                  {by(h)}
                  <span className="block text-sm text-slate-600">{formatWhen(h.created_at)}</span>
                </Link>
              </li>
            ),
          )}
        </ul>
      )}
      {tab === 'history' && <PollRefresh />}
    </div>
  );
}
