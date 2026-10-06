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
  stockList,
  supplyContext,
  type SearchParams,
} from '@/lib/inventory';
import { itemPhotoUrls, photosEnabled } from '@/lib/photos';
import { ItemPhoto } from './item-photo';

// One item: its photo (UX-6, ADR 034), what is on hand, and its movements at the node (the
// ledger, newest first).
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
  const { item, rows, canPhoto } = await withUser(user.id, async (tx) => ({
    item: (await stockList(tx, ctx.node!.id)).find((r) => r.item_id === id),
    rows: await ledger(tx, ctx.node!.id, id),
    canPhoto: (
      await sql<{ ok: boolean }>`select inv.can_set_item_photo(${id}::uuid) as ok`.execute(tx)
    ).rows[0]?.ok,
  }));
  if (!item) return <Empty>This item isn&apos;t set up here.</Empty>;
  const photo = (await itemPhotoUrls([item])).get(item.item_id);
  return (
    <div className="space-y-4">
      <Link href={`/stock?node=${ctx.node.id}`} className="text-sm text-slate-600">
        ← Stock at {ctx.node.name}
      </Link>
      <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <div className="flex items-center gap-3">
          <ItemThumb category={item.category} src={photo} size="size-20" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">{item.name}</h1>
            <p className="text-sm text-slate-600">{item.sku}</p>
          </div>
        </div>
        <p className="text-2xl font-semibold tabular-nums">
          {formatQty(item.on_hand, item.base_uom)}
        </p>
        <p className="text-sm text-slate-600">par {formatQty(item.par_level, item.base_uom)}</p>
        {canPhoto && photosEnabled() && <ItemPhoto item={item.item_id} has={!!item.photo_key} />}
      </div>
      <h2 className="text-sm font-semibold text-slate-500">Latest movements</h2>
      {rows.length === 0 ? (
        <Empty>No movements yet.</Empty>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {rows.map((r) => (
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
    </div>
  );
}
