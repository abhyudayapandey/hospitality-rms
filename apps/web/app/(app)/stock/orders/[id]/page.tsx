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
import { mailtoLink, orderRef, orderSubject, orderText, whatsappLink } from '@/lib/po-message';
import { companySettings } from '@/lib/settings-data';
import { ContactForm } from './contact-form';
import { ReceiveForm, type ReceiveLine } from './receive-form';
import { PlaceOrderForm, type PlaceLine } from './place-order-form';
import { SendCard } from './send-card';
import { BillForm } from '../../bills/bill-form';

const CHANNEL = { whatsapp: 'on WhatsApp', email: 'by email', print: 'printed' } as const;

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const ctx = await supplyContext(searchParams, 'orders');
  if (!ctx.can('PURCHASE_ORDERS') || !ctx.node) return <NoSupplyAccess />;
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    // the order desk (the Main Store's keeper) places and receives for other stores, whose rows
    // RLS hides from them: these read through inv.order_for_desk (ADR 049)
    const desk = await sql<{
      id: string;
      store_id: string;
      store: string;
      supplier_id: string | null;
      supplier: string | null;
      created_at: Date;
      expected_on: Date | null;
      status: string;
      progress: string;
      notes: string | null;
      total: string;
    }>`select * from inv.order_for_desk(${id}::uuid)`.execute(tx);
    const canPlace = desk.rows.length > 0;
    const po = await sql<{
      id: string;
      delivery_node_id: string;
      store: string;
      supplier_id: string | null;
      supplier: string | null;
      phone: string | null;
      email: string | null;
      total: string;
      status: string;
      progress: string;
      notes: string | null;
      created_at: Date;
      expected_on: Date | null;
      can_modify: boolean;
    }>`
      select po.id, po.delivery_node_id, core.node_name(po.delivery_node_id) as store,
             s.id as supplier_id, s.name as supplier, s.phone, s.contact as email, po.total,
             po.status, po.progress, po.notes, po.created_at, po.expected_on,
             core.can('PURCHASE_ORDERS', 'modify', null, po.delivery_node_id) as can_modify
        from inv.purchase_order_summary po left join inv.supplier s on s.id = po.supplier_id
       where po.id = ${id}::uuid`.execute(tx);
    const row =
      po.rows[0] ??
      (desk.rows[0]
        ? {
            id: desk.rows[0].id,
            delivery_node_id: desk.rows[0].store_id,
            store: desk.rows[0].store,
            supplier_id: desk.rows[0].supplier_id,
            supplier: desk.rows[0].supplier,
            phone: null,
            email: null,
            total: desk.rows[0].total,
            status: desk.rows[0].status,
            progress: desk.rows[0].progress,
            notes: desk.rows[0].notes,
            created_at: desk.rows[0].created_at,
            expected_on: desk.rows[0].expected_on,
            can_modify: false,
          }
        : undefined);
    const lines = canPlace
      ? await sql<ReceiveLine & { unit_cost: string; preferred_supplier_id: string | null }>`
          select item_id, name, base_uom, qty as ordered, unit_cost, received, preferred_supplier_id
            from inv.order_lines_for_desk(${id}::uuid)`.execute(tx)
      : await sql<ReceiveLine & { unit_cost: string; preferred_supplier_id: string | null }>`
          select pl.item_id, i.name, i.base_uom, pl.qty as ordered, pl.unit_cost,
                 null::uuid as preferred_supplier_id,
                 coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                            where gl.po_line_id = pl.id), 0) as received
            from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
           where pl.po_id = ${id}::uuid order by i.name`.execute(tx);
    const sends = po.rows[0]
      ? await sql<{ channel: 'whatsapp' | 'email' | 'print'; sent_at: Date; sent_by_name: string }>`
          select channel, sent_at, sent_by_name from inv.po_sends(${id}::uuid)`.execute(tx)
      : { rows: [] };
    // the bills for this order (BIL-1, ADR 050), for whoever sees or places it
    const bills = await sql<{
      id: string;
      bill_no: string | null;
      bill_date: Date;
      amount: string;
      files: number;
    }>`select id, bill_no, bill_date, amount, files from inv.po_bills(${id}::uuid)`.execute(tx);
    // the desk picks suppliers; a bill for an order placed with none names its supplier
    const suppliers =
      canPlace || (row && !row.supplier_id)
        ? (
            await sql<{ id: string; name: string }>`
            select id, name from inv.supplier where archived_at is null order by name`.execute(tx)
          ).rows
        : [];
    return {
      po: row,
      canPlace,
      lines: lines.rows,
      suppliers,
      sends: sends.rows,
      bills: bills.rows,
      prices: (await companySettings(tx)).po_send_prices,
    };
  });
  if (!data.po) return <Empty>Order not found.</Empty>;
  const { po, lines, sends, prices, canPlace, suppliers, bills } = data;
  const supplierName = po.supplier ?? 'Supplies request';
  // PO-4 (ADR 032): a released order goes to the supplier from this phone
  const message = {
    store: po.store,
    supplier: supplierName,
    ref: orderRef(po.id),
    orderedOn: new Date(po.created_at).toISOString().slice(0, 10),
    lines: lines.map((l) => ({
      name: l.name,
      qty: l.ordered,
      unit: l.base_uom,
      unitCost: l.unit_cost,
    })),
    prices,
    sender: user.name,
  };
  const text = orderText(message);
  const canSend =
    po.can_modify &&
    po.status === 'released' &&
    po.supplier_id !== null &&
    po.progress !== 'to_order';
  const [label, style] = PROGRESS[po.progress] ?? [po.progress, ''];
  const canReceive =
    (po.can_modify || canPlace) &&
    (po.progress === 'released' || po.progress === 'partially_received');
  // prices are for whoever orders and receives; the person who asked sees items and quantities
  const showPrices = po.supplier_id !== null && (po.can_modify || canPlace);
  return (
    <div className="space-y-4">
      <Link href={`/stock/orders?node=${po.delivery_node_id}`} className="text-sm text-slate-600">
        ← Orders
      </Link>
      <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold">{supplierName}</h1>
          <span
            data-testid="po-progress"
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}
          >
            {label}
          </span>
        </div>
        <p className="text-sm text-slate-600">
          {po.store} · {formatWhen(po.created_at)}
          {showPrices && ` · ${formatMoney(po.total)}`}
          {po.expected_on && ` · due ${new Date(po.expected_on).toISOString().slice(0, 10)}`}
        </p>
        {po.notes && <p className="mt-1 text-sm">{po.notes}</p>}
      </div>
      {canSend && (
        <SendCard
          po={po.id}
          whatsapp={whatsappLink(po.phone, text)}
          mailto={mailtoLink(po.email, orderSubject(message), text)}
          sent={sends.map((x) => ({
            channel: x.channel,
            label: `Sent ${CHANNEL[x.channel]} by ${x.sent_by_name}, ${formatWhen(x.sent_at)}`,
          }))}
        />
      )}
      {!canSend && sends.length > 0 && (
        <ul className="space-y-1 text-sm text-slate-600" data-testid="sends">
          {sends.map((x, i) => (
            <li key={i}>
              Sent {CHANNEL[x.channel]} by {x.sent_by_name}, {formatWhen(x.sent_at)}
            </li>
          ))}
        </ul>
      )}
      {canPlace && po.progress === 'to_order' && (
        <PlaceOrderForm
          po={po.id}
          suppliers={suppliers}
          lines={lines.map((l): PlaceLine => ({
            item_id: l.item_id,
            name: l.name,
            base_uom: l.base_uom,
            qty: l.ordered,
            preferred_supplier_id: l.preferred_supplier_id,
          }))}
        />
      )}
      {po.progress === 'to_order' ? (
        !canPlace && (
          <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            {lines.map((l) => (
              <li key={l.item_id} className="flex justify-between gap-2 px-4 py-3 text-sm">
                <span className="font-medium">{l.name}</span>
                <span className="tabular-nums">{formatQty(l.ordered, l.base_uom)}</span>
              </li>
            ))}
          </ul>
        )
      ) : canReceive ? (
        <ReceiveForm po={po.id} lines={lines} />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {lines.map((l) => (
            <li key={l.item_id} className="flex justify-between gap-2 px-4 py-3 text-sm">
              <span className="font-medium">{l.name}</span>
              <span className="text-right tabular-nums">
                {formatQty(l.ordered, l.base_uom)}
                {showPrices && ` × ${formatMoney(l.unit_cost)}`}
                <span className="block text-xs text-slate-500">
                  received {formatQty(l.received, l.base_uom)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {['released', 'partially_received', 'received'].includes(po.progress) &&
        (bills.length > 0 || po.can_modify || canPlace) && (
          <section className="space-y-2" data-testid="po-bills">
            <h2 className="text-sm font-semibold text-slate-500">Bill</h2>
            {bills.length > 0 && (
              <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
                {bills.map((b) => (
                  <li key={b.id}>
                    <Link
                      href={`/stock/bills/${b.id}?node=${po.delivery_node_id}`}
                      className="flex min-h-12 items-center justify-between gap-2 px-4 py-2 text-sm"
                      data-testid="po-bill"
                    >
                      <span>
                        {new Date(b.bill_date).toISOString().slice(0, 10)}
                        {b.bill_no && ` · ${b.bill_no}`}
                        <span className="block text-xs text-slate-500">
                          {b.files} {b.files === 1 ? 'page' : 'pages'}
                        </span>
                      </span>
                      <span className="font-semibold tabular-nums">{formatMoney(b.amount)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {(po.can_modify || canPlace) && (
              <details
                open={bills.length === 0 && po.progress !== 'released'}
                className="rounded-xl bg-white p-4 ring-1 ring-slate-200"
              >
                <summary className="min-h-11 cursor-pointer py-2 font-medium">
                  {bills.length === 0 ? 'Add the bill' : 'Add another bill'}
                </summary>
                <div className="pt-2">
                  <BillForm
                    node={null}
                    po={po.id}
                    askSupplier={!po.supplier_id}
                    suppliers={suppliers}
                  />
                </div>
              </details>
            )}
          </section>
        )}
      {po.can_modify && po.supplier_id && (
        <ContactForm supplier={po.supplier_id} phone={po.phone} email={po.email} />
      )}
    </div>
  );
}
