import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoSupplyAccess } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { photosEnabled } from '@/lib/photos';
import { supplyContext, type SearchParams } from '@/lib/inventory';
import { CheckSheet, type SheetLine } from './check-sheet';

export default async function StockCheckSheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const ctx = await supplyContext(searchParams, 'check');
  if (!ctx.can('STOCK_CHECK', 'modify') || !ctx.node) return <NoSupplyAccess />;
  const user = await requireUser();
  const { check, lines } = await withUser(user.id, async (tx) => {
    const c = await sql<{ id: string; status: string; mode: string; delivery_node_id: string }>`
      select id, status, mode, delivery_node_id from inv.stock_check
       where id = ${id}::uuid`.execute(tx);
    // the sheet never carries what should be left: the count is blind
    const l = c.rows[0]
      ? await sql<SheetLine>`
          select item_id, name, unit, shelf, area, counted_qty, full_units, tenths,
                 pack_unit, pack_size, photo_key
            from inv.stock_check_sheet(${id}::uuid)`.execute(tx)
      : { rows: [] as SheetLine[] };
    return { check: c.rows[0], lines: l.rows };
  });
  if (!check) return <Empty>Stock check not found.</Empty>;
  const back = `/stock/check?node=${check.delivery_node_id}`;
  return (
    <div className="space-y-4">
      <Link href={back} className="text-sm text-slate-600">
        ← Stock check
      </Link>
      <h1 className="text-xl font-semibold">
        {check.mode === 'bar' ? 'Bar check' : 'Stock check'} at {ctx.node.name}
      </h1>
      {check.status === 'finished' ? (
        <p
          role="status"
          className="rounded-lg bg-emerald-50 p-3 text-sm font-medium text-emerald-800"
        >
          This stock check is finished.
        </p>
      ) : (
        <CheckSheet
          checkId={id}
          node={check.delivery_node_id}
          mode={check.mode as 'standard' | 'bar'}
          status={check.status as 'open' | 'review'}
          lines={lines}
          userId={user.id}
          photos={photosEnabled()}
          back={back}
        />
      )}
    </div>
  );
}
