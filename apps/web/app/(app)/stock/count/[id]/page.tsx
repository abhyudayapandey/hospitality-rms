import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoSupplyAccess } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatQty, supplyContext, type SearchParams } from '@/lib/inventory';
import { CountForm, type CountLine } from './count-form';

export default async function CountSheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const ctx = await supplyContext(searchParams);
  if (!ctx.can('STOCK_ADJUSTMENTS', 'modify') || !ctx.node) return <NoSupplyAccess />;
  const user = await requireUser();
  const { count, lines } = await withUser(user.id, async (tx) => {
    const c = await sql<{ id: string; status: string; delivery_node_id: string }>`
      select id, status, delivery_node_id from inv.stock_count where id = ${id}::uuid`.execute(tx);
    const l = await sql<CountLine & { system_qty: string; outcome: string | null }>`
      select cl.item_id, i.name, i.category, i.base_uom, cl.counted_qty, cl.system_qty, cl.outcome
        from inv.stock_count_line cl join inv.item i on i.id = cl.item_id
       where cl.count_id = ${id}::uuid
       order by i.category, i.name`.execute(tx);
    return { count: c.rows[0], lines: l.rows };
  });
  if (!count) return <Empty>Count not found.</Empty>;
  const back = `/stock/count?node=${count.delivery_node_id}`;
  if (count.status === 'submitted') {
    const label = { posted: 'posted', approval: 'sent for approval', no_change: 'no change' };
    return (
      <div className="space-y-4">
        <Link href={back} className="text-sm text-slate-600">
          ← Counts
        </Link>
        <h1 className="text-xl font-semibold">Submitted count</h1>
        <p
          role="status"
          className="rounded-lg bg-emerald-50 p-3 text-sm font-medium text-emerald-800"
        >
          {lines.filter((l) => l.outcome === 'posted').length} posted,{' '}
          {lines.filter((l) => l.outcome === 'approval').length} sent for approval,{' '}
          {lines.filter((l) => (l.outcome ?? 'no_change') === 'no_change').length} unchanged.
        </p>
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {lines.map((l) => (
            <li key={l.item_id} className="flex justify-between gap-2 px-4 py-3 text-sm">
              <span>{l.name}</span>
              <span className="text-right tabular-nums">
                {l.counted_qty === null ? '—' : formatQty(l.counted_qty, l.base_uom)} ·{' '}
                {label[(l.outcome ?? 'no_change') as keyof typeof label]}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Link href={back} className="text-sm text-slate-600">
        ← Counts
      </Link>
      <h1 className="text-xl font-semibold">Count at {ctx.node.name}</h1>
      <CountForm
        countId={id}
        node={count.delivery_node_id}
        lines={lines.map(({ item_id, name, category, base_uom, counted_qty }) => ({
          item_id,
          name,
          category,
          base_uom,
          counted_qty,
        }))}
      />
    </div>
  );
}
