import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { formatQty } from '@/lib/inventory';
import { orderRef } from '@/lib/po-message';
import { companySettings } from '@/lib/settings-data';
import { PrintButton } from './print-button';

// The order as a page to print or save as PDF for the supplier (PO-4, ADR 032): the store,
// the supplier, each item and quantity; prices only when the company shows them on sent
// orders. Opened from the order's "Send to supplier", which records the send.
export default async function PrintOrder({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const po = await sql<{
      id: string;
      store: string;
      supplier: string;
      phone: string | null;
      email: string | null;
      created_at: Date;
      total: string;
    }>`
      select po.id, core.node_name(po.delivery_node_id) as store, s.name as supplier, s.phone,
             s.contact as email, po.created_at, po.total
        from inv.purchase_order po join inv.supplier s on s.id = po.supplier_id
       where po.id = ${id}::uuid and po.status = 'released'
         and core.can('PURCHASE_ORDERS', 'modify', null, po.delivery_node_id)`.execute(tx);
    // the Main Store's keeper sends what they ordered for a department, whose rows RLS hides
    // from them: read through the order desk (ADR 049, 052)
    const desk = po.rows[0]
      ? null
      : await sql<{
          id: string;
          store: string;
          supplier: string;
          phone: string | null;
          email: string | null;
          created_at: Date;
          total: string;
        }>`
          select d.id, d.store, s.name as supplier, s.phone, s.contact as email, d.created_at,
                 d.total
            from inv.order_for_desk(${id}::uuid) d join inv.supplier s on s.id = d.supplier_id
           where d.status = 'released'`.execute(tx);
    const lines = desk
      ? await sql<{ name: string; unit: string; qty: string; unit_cost: string }>`
          select name, base_uom as unit, qty, unit_cost
            from inv.order_lines_for_desk(${id}::uuid) order by name`.execute(tx)
      : await sql<{ name: string; unit: string; qty: string; unit_cost: string }>`
          select i.name, i.base_uom as unit, pl.qty, pl.unit_cost
            from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
           where pl.po_id = ${id}::uuid order by i.name`.execute(tx);
    return {
      po: po.rows[0] ?? desk?.rows[0],
      lines: lines.rows,
      prices: (await companySettings(tx)).po_send_prices,
    };
  });
  if (!data.po) return <Empty>Order not found.</Empty>;
  const { po, lines, prices } = data;
  return (
    <article className="space-y-4 bg-white p-4 print:p-0" data-testid="printable-order">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <Link href={`/stock/orders/${po.id}`} className="text-sm text-slate-600">
          ← Order
        </Link>
        <PrintButton />
      </div>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Purchase order {orderRef(po.id)}</h1>
        <p className="text-sm">
          From <strong>{po.store}</strong>
        </p>
        <p className="text-sm">
          To <strong>{po.supplier}</strong>
          {po.phone && ` · ${po.phone}`}
          {po.email && ` · ${po.email}`}
        </p>
        <p className="text-sm">Date {new Date(po.created_at).toISOString().slice(0, 10)}</p>
      </header>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-400 text-left">
            <th className="py-1">Item</th>
            <th className="py-1 text-right">Quantity</th>
            {prices && <th className="py-1 text-right">Price</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.name} className="border-b border-slate-200">
              <td className="py-1">{l.name}</td>
              <td className="py-1 text-right tabular-nums">{formatQty(l.qty, l.unit)}</td>
              {prices && (
                <td className="py-1 text-right tabular-nums">
                  {formatMoney(l.unit_cost)} / {l.unit}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        {prices && (
          <tfoot>
            <tr>
              <td className="py-1 font-semibold" colSpan={2}>
                Total
              </td>
              <td className="py-1 text-right font-semibold tabular-nums">
                {formatMoney(po.total)}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
      <p className="text-sm">Please confirm the delivery date. Ordered by {user.name}.</p>
    </article>
  );
}
