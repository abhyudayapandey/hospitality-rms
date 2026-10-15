import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoSupplyAccess } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { ItemThumb } from '@/components/item-thumb';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import {
  formatQty,
  ledger,
  movementLabel,
  PO_PROGRESS,
  stockList,
  supplyContext,
  TRANSFER_PROGRESS,
  type SearchParams,
} from '@/lib/inventory';
import { packItems } from '@/lib/opened-packs';
import { itemRequests } from '@/lib/item-requests';
import { param } from '@/lib/params';
import { itemPhotoUrls, photosEnabled } from '@/lib/photos';
import { ItemPhoto } from './item-photo';

// One item (ADR 034, 134): its photo and what is on hand, its five latest movements with Show
// all (the ledger, newest first), its open requests, then Request more (from the store that
// keeps it, else to buy it): the information first, its action after (ADR 051).
export default async function ItemLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const ctx = await supplyContext(searchParams, 'stock');
  if (!ctx.can('STOCK_LEVELS') || !ctx.node) return <NoSupplyAccess />;
  const user = await requireUser();
  const canOpenPacks = ctx.can('SHELF_LIFE', 'modify') && ctx.opensPacks;
  const all = param(await searchParams, 'all') === '1';
  // what the person may do is checked at this store, never from a grant elsewhere (ADR 149):
  // a store where they may only look opens with no "Request more"
  const grants = ctx.node.derived
    ? { ask: false, buy: false }
    : await withUser(user.id, async (tx) => {
        const r = await sql<{ ask: boolean; buy: boolean }>`
          select coalesce(core.can('TRANSFERS', 'modify', null, ${ctx.node!.id}::uuid), false) as ask,
                 coalesce(core.can('PURCHASE_ORDERS', 'modify', null, ${ctx.node!.id}::uuid), false)
                   as buy`.execute(tx);
        return r.rows[0] ?? { ask: false, buy: false };
      });
  const canAsk = ctx.can('TRANSFERS', 'modify') && grants.ask;
  const canBuy = ctx.can('PURCHASE_ORDERS', 'modify') && grants.buy;
  const { item, rows, canPhoto, pack, requests, source } = await withUser(user.id, async (tx) => ({
    requests: await itemRequests(tx, ctx.node!.id, id),
    // where more comes from: the store that keeps it (ADR 115), else it is bought
    source: canAsk
      ? ((
          await sql<{ source_id: string | null }>`
            select source_id::text from inv.ask_items(${ctx.node!.id}::uuid)
             where item_id = ${id}::uuid`.execute(tx)
        ).rows[0]?.source_id ?? null)
      : null,
    item: (await stockList(tx, ctx.node!.id)).find((r) => r.item_id === id),
    rows: await ledger(tx, ctx.node!.id, id),
    canPhoto: (
      await sql<{ ok: boolean }>`select inv.can_set_item_photo(${id}::uuid) as ok`.execute(tx)
    ).rows[0]?.ok,
    // an item with a shelf life once opened is opened from here too (ADR 097)
    pack: canOpenPacks
      ? (await packItems(tx, ctx.node!.id)).find((p) => p.item_id === id)
      : undefined,
  }));
  if (!item) return <Empty>This item isn&apos;t set up here.</Empty>;
  const photo = (await itemPhotoUrls([item])).get(item.item_id);
  const askHref = source
    ? `/stock/transfers/new?node=${ctx.node.id}&item=${item.item_id}`
    : canBuy
      ? `/stock/orders/new?node=${ctx.node.id}&item=${item.item_id}`
      : null;
  const shown = all ? rows : rows.slice(0, 5);
  return (
    <div className="space-y-4">
      <Link href={`/stock?node=${ctx.node.id}`} className="text-sm text-slate-600">
        ← Stock at {ctx.node.name}
      </Link>
      <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <div className="flex items-center gap-3">
          <ItemThumb name={item.name} category={item.category} src={photo} size="size-20" />
          <h1 className="min-w-0 text-lg font-semibold">{item.name}</h1>
        </div>
        <p className="text-2xl font-semibold tabular-nums">
          {formatQty(item.on_hand, item.base_uom)}
        </p>
        <p className="text-sm text-slate-600">par {formatQty(item.par_level, item.base_uom)}</p>
        {canPhoto && photosEnabled() && <ItemPhoto item={item.item_id} has={!!item.photo_key} />}
        {pack && (
          <Link
            href={`/stock/opened?node=${ctx.node.id}&item=${item.item_id}`}
            className="flex min-h-12 items-center justify-center rounded-lg border border-slate-300 bg-white font-medium"
            data-testid="open-a-pack"
          >
            Open a pack
          </Link>
        )}
      </div>
      <h2 className="text-sm font-semibold text-slate-500">Latest movements</h2>
      {rows.length === 0 ? (
        <Empty>No movements yet.</Empty>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {shown.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <span>
                <span className="block text-sm font-medium">
                  {movementLabel(r.movement_type, r.reason)}
                </span>
                <span className="text-xs text-slate-500">{formatWhen(r.occurred_at)}</span>
              </span>
              <span
                className={`font-semibold tabular-nums ${Number(r.qty) < 0 ? 'text-rose-700' : 'text-emerald-700'}`}
              >
                {Number(r.qty) > 0 ? '+' : ''}
                {formatQty(r.qty, r.base_uom)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!all && rows.length > 5 && (
        <Link
          href={`/stock/items/${item.item_id}?node=${ctx.node.id}&all=1`}
          className="flex min-h-11 items-center justify-center text-sm font-medium text-brand-700 underline"
          data-testid="movements-all"
        >
          Show all {rows.length}
        </Link>
      )}
      <h2 className="text-sm font-semibold text-slate-500">Requests</h2>
      {requests.length === 0 ? (
        <Empty>Nothing asked for yet.</Empty>
      ) : (
        <ul
          className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
          data-testid="item-requests"
        >
          {requests.map((r) => {
            const [word, tone] = (r.kind === 'stock' ? TRANSFER_PROGRESS : PO_PROGRESS)[
              r.progress
            ] ?? [r.progress, ''];
            return (
              <li key={`${r.kind}-${r.id}`}>
                <Link
                  href={
                    r.kind === 'stock'
                      ? `/stock/transfers/${r.id}?node=${ctx.node!.id}`
                      : `/stock/orders/${r.id}?node=${ctx.node!.id}`
                  }
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <span>
                    <span className="block text-sm font-medium">
                      {formatQty(r.qty, item.base_uom)}
                      {r.source ? ` from ${r.source}` : ''}
                    </span>
                    <span className="text-xs text-slate-500">{formatWhen(r.created_at)}</span>
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
                    {word}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {askHref && (
        <Link
          href={askHref}
          data-testid="ask-for-more"
          className="flex min-h-12 items-center justify-center rounded-lg bg-brand-700 font-semibold text-white"
        >
          Request more
        </Link>
      )}
    </div>
  );
}
