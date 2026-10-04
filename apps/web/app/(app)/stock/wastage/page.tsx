import { Empty } from '@/components/messages';
import { NoSupplyAccess, SupplyHeader } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatMoney, formatWhen } from '@/lib/format';
import { formatQty, itemOptions, param, supplyContext, type SearchParams } from '@/lib/inventory';
import { photosEnabled } from '@/lib/photos';
import { WastageForm } from './wastage-form';

export default async function WastagePage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'wastage');
  if (!ctx.can('STOCK_ADJUSTMENTS', 'modify') || !ctx.node || ctx.node.derived) {
    return <NoSupplyAccess />;
  }
  const sp = await searchParams;
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const items = await itemOptions(tx, ctx.node!.id);
    const t = await sql<{ v: string }>`
      select inv.wastage_threshold(${ctx.node!.id}::uuid) as v`.execute(tx);
    const recent = await sql<{
      id: string;
      name: string;
      base_uom: string;
      qty: string;
      reason: string;
      value: string;
      outcome: string;
      created_at: Date;
    }>`
      select wl.id, i.name, i.base_uom, wl.qty, wl.reason, wl.value, wl.outcome, wl.created_at
        from inv.wastage_line wl join inv.item i on i.id = wl.item_id
       where wl.delivery_node_id = ${ctx.node!.id}::uuid
       order by wl.created_at desc limit 10`.execute(tx);
    return { items, threshold: Number(t.rows[0]!.v), recent: recent.rows };
  });
  return (
    <div className="space-y-4">
      <SupplyHeader ctx={ctx} active="/stock/wastage" title="Wastage" />
      <WastageForm
        node={ctx.node.id}
        userId={ctx.shell.user.id}
        items={data.items}
        threshold={data.threshold}
        photos={photosEnabled()}
        initial={{ item: param(sp, 'item'), qty: param(sp, 'qty'), reason: param(sp, 'reason') }}
      />
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-500">Recent wastage</h2>
        {data.recent.length === 0 ? (
          <Empty>No wastage recorded here yet.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            {data.recent.map((r) => (
              <li key={r.id} className="flex justify-between gap-2 px-4 py-3 text-sm">
                <span>
                  <span className="block font-medium">{r.name}</span>
                  <span className="text-xs text-slate-500">
                    {r.reason.replace(/_/g, ' ')} · {formatWhen(r.created_at)}
                  </span>
                </span>
                <span className="text-right tabular-nums">
                  {formatQty(r.qty, r.base_uom)}
                  <span className="block text-xs text-slate-500">
                    {formatMoney(r.value)} ·{' '}
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
