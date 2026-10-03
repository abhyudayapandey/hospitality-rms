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
import { SendCard } from './send-card';

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
    const po = await sql<{
      id: string;
      delivery_node_id: string;
      store: string;
      supplier_id: string;
      supplier: string;
      phone: string | null;
      email: string | null;
      total: string;
      status: string;
      progress: string;
      notes: string | null;
      created_at: Date;
      can_modify: boolean;
    }>`
      select po.id, po.delivery_node_id, core.node_name(po.delivery_node_id) as store,
             s.id as supplier_id, s.name as supplier, s.phone, s.contact as email, po.total,
             po.status, po.progress, po.notes, po.created_at,
             core.can('PURCHASE_ORDERS', 'modify', null, po.delivery_node_id) as can_modify
        from inv.purchase_order_summary po join inv.supplier s on s.id = po.supplier_id
       where po.id = ${id}::uuid`.execute(tx);
    const lines = await sql<ReceiveLine & { unit_cost: string }>`
      select pl.item_id, i.name, i.base_uom, pl.qty as ordered, pl.unit_cost,
             coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                        where gl.po_line_id = pl.id), 0) as received
        from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
       where pl.po_id = ${id}::uuid order by i.name`.execute(tx);
    const sends = po.rows[0]
      ? await sql<{ channel: 'whatsapp' | 'email' | 'print'; sent_at: Date; sent_by_name: string }>`
          select channel, sent_at, sent_by_name from inv.po_sends(${id}::uuid)`.execute(tx)
      : { rows: [] };
    return {
      po: po.rows[0],
      lines: lines.rows,
      sends: sends.rows,
      prices: (await companySettings(tx)).po_send_prices,
    };
  });
  if (!data.po) return <Empty>Order not found.</Empty>;
  const { po, lines, sends, prices } = data;
  // PO-4 (ADR 032): a released order goes to the supplier from this phone
  const message = {
    store: po.store,
    supplier: po.supplier,
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
  const canSend = po.can_modify && po.status === 'released';
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
      {po.can_modify && <ContactForm supplier={po.supplier_id} phone={po.phone} email={po.email} />}
    </div>
  );
}
