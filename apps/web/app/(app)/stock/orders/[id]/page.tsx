import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoSupplyAccess } from '@/components/supply-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatMoney, formatWhen } from '@/lib/format';
import {
  formatQty,
  PO_PROGRESS as PROGRESS,
  supplyContext,
  type SearchParams,
} from '@/lib/inventory';
import { ReceiveForm, type ReceiveLine } from './receive-form';

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const ctx = await supplyContext(searchParams);
  if (!ctx.can('PURCHASE_ORDERS') || !ctx.node) return <NoSupplyAccess />;
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const po = await sql<{
      id: string;
      delivery_node_id: string;
      supplier: string;
      total: string;
      progress: string;
      notes: string | null;
      created_at: Date;
      can_modify: boolean;
    }>`
      select po.id, po.delivery_node_id, s.name as supplier, po.total, po.progress, po.notes,
             po.created_at,
             core.can('PURCHASE_ORDERS', 'modify', null, po.delivery_node_id) as can_modify
        from inv.purchase_order_summary po join inv.supplier s on s.id = po.supplier_id
       where po.id = ${id}::uuid`.execute(tx);
    const lines = await sql<ReceiveLine & { unit_cost: string }>`
      select pl.item_id, i.name, i.base_uom, pl.qty as ordered, pl.unit_cost,
             coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                        where gl.po_line_id = pl.id), 0) as received
        from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
       where pl.po_id = ${id}::uuid order by i.name`.execute(tx);
    return { po: po.rows[0], lines: lines.rows };
  });
  if (!data.po) return <Empty>Order not found.</Empty>;
  const { po, lines } = data;
  const [label, style] = PROGRESS[po.progress] ?? [po.progress, ''];
  const canReceive =
    po.can_modify && (po.progress === 'released' || po.progress === 'partially_received');
  return (
    <div className="space-y-4">
      <Link href={`/stock/orders?node=${po.delivery_node_id}`} className="text-sm text-slate-600">
        ← Orders
      </Link>
      <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold">{po.supplier}</h1>
          <span
            data-testid="po-progress"
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}
          >
            {label}
          </span>
        </div>
        <p className="text-sm text-slate-600">
          {formatWhen(po.created_at)} · {formatMoney(po.total)}
        </p>
        {po.notes && <p className="mt-1 text-sm">{po.notes}</p>}
      </div>
      {canReceive ? (
        <ReceiveForm po={po.id} lines={lines} />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {lines.map((l) => (
            <li key={l.item_id} className="flex justify-between gap-2 px-4 py-3 text-sm">
              <span className="font-medium">{l.name}</span>
              <span className="text-right tabular-nums">
                {formatQty(l.ordered, l.base_uom)} × {formatMoney(l.unit_cost)}
                <span className="block text-xs text-slate-500">
                  received {formatQty(l.received, l.base_uom)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
