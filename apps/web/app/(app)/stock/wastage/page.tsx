import { Empty } from '@/components/messages';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatMoney, formatWhen } from '@/lib/format';
import { formatQty, itemOptions, param, supplyContext, type SearchParams } from '@/lib/inventory';
import { photosEnabled } from '@/lib/photos';
import { WastageForm } from './wastage-form';
import { ItemThumb } from '@/components/item-thumb';
import { ListDays } from '@/components/date-range';
import { listDays } from '@/lib/list-days';
import { wastageList } from '@/lib/wastage-list';

export default async function WastagePage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'wastage');
  if (!ctx.can('STOCK_ADJUSTMENTS', 'modify') || !ctx.node || ctx.node.derived) {
    return <NoSupplyAccess />;
  }
  const sp = await searchParams;
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const items = await itemOptions(tx, ctx.node!.id);
    // the limit in ₹ only for whoever sees what stock is worth here (KI-09)
    const t = await sql<{ v: string | null }>`
      select case when inv.sees_store_money(${ctx.node!.id}::uuid)
                  then inv.wastage_threshold(${ctx.node!.id}::uuid) end as v`.execute(tx);
    const { range, today } = await listDays(tx, sp, ctx.node!.id);
    // the latest ten, or every line on the days chosen (ADR 120)
    const recent = await wastageList(tx, ctx.node!.id, range, range ? 500 : 10);
    const v = t.rows[0]?.v ?? null;
    return { items, threshold: v === null ? null : Number(v), recent, range, today };
  });
  return (
    <div className="space-y-4">
      <SupplyHeader ctx={ctx} active="/stock/wastage" title="Wastage" />
      <WastageForm
        node={ctx.node.id}
        userId={ctx.shell.user.id}
        items={data.items}
        often={[...new Set(data.recent.map((r) => r.item_id))]}
        threshold={data.threshold}
        photos={photosEnabled()}
        initial={{ item: param(sp, 'item'), qty: param(sp, 'qty'), reason: param(sp, 'reason') }}
      />
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-500">
          {data.range ? 'Wastage' : 'Recent wastage'}
        </h2>
        <ListDays
          path="/stock/wastage"
          params={{ node: ctx.node.id }}
          range={data.range}
          today={data.today}
          list="wastage"
        />
        {data.recent.length === 0 ? (
          <Empty>
            {data.range ? 'No wastage on these days.' : 'No wastage recorded here yet.'}
          </Empty>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            {data.recent.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 px-4 py-3 text-sm">
                <ItemThumb name={r.name} size="size-10" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{r.name}</span>
                  <span className="text-xs text-slate-500">
                    {r.reason.replace(/_/g, ' ')} · {formatWhen(r.created_at)}
                  </span>
                </span>
                <span className="text-right tabular-nums">
                  {formatQty(r.qty, r.base_uom)}
                  <span className="block text-xs text-slate-500">
                    {r.value !== null && `${formatMoney(r.value)} · `}
                    {r.outcome === 'approval' ? 'needs approval' : 'posted'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
