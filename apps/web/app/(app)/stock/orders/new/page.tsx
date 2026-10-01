import Link from 'next/link';
import { NoSupplyAccess } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { supplyContext, type SearchParams } from '@/lib/inventory';
import { NewOrderForm, type OrderLine } from './new-order-form';

export default async function NewOrderPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await supplyContext(searchParams, 'orders');
  if (!ctx.can('PURCHASE_ORDERS', 'modify') || !ctx.node || ctx.node.derived) {
    return <NoSupplyAccess />;
  }
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const lines = await sql<OrderLine>`
      select s.item_id, i.name, i.base_uom, s.on_hand, s.par_level, s.suggested_qty,
             coalesce(s.last_unit_cost, lv.avg_cost, 0) as unit_cost, s.preferred_supplier_id
        from inv.suggested_order(${ctx.node!.id}::uuid) s
        join inv.item i on i.id = s.item_id
        left join inv.stock_level lv
          on lv.item_id = s.item_id and lv.delivery_node_id = ${ctx.node!.id}::uuid
       order by (s.suggested_qty > 0) desc, i.name`.execute(tx);
    const suppliers = await sql<{ id: string; name: string }>`
      select id, name from inv.supplier where archived_at is null order by name`.execute(tx);
    return { lines: lines.rows, suppliers: suppliers.rows };
  });
  return (
    <div className="space-y-4">
      <Link href={`/stock/orders?node=${ctx.node.id}`} className="text-sm text-slate-600">
        ← Orders
      </Link>
      <h1 className="text-xl font-semibold">New order for {ctx.node.name}</h1>
      <p className="text-sm text-slate-600">
        Quantities start at the suggestion: par level minus stock on hand minus what is already on
        order.
      </p>
      <NewOrderForm node={ctx.node.id} lines={data.lines} suppliers={data.suppliers} />
    </div>
  );
}
