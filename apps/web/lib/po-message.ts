// Sending an order to the supplier (PO-4, ADR 032). Pure: the message, and the WhatsApp and
// email links that open the person's own apps. There is no server email (the AWS Free plan
// has no SES); the app records each send (inv.record_po_send).

export interface OrderLine {
  name: string;
  qty: string | number;
  unit: string;
  unitCost: string | number;
}

export interface OrderMessage {
  /** "Test Hotel & Bar 1.0 – Kitchen Store" */
  store: string;
  supplier: string;
  ref: string;
  /** ISO date the order was raised */
  orderedOn: string;
  lines: readonly OrderLine[];
  /** the company setting: quantities only unless it is on */
  prices: boolean;
  /** who is sending it, so the supplier can call back */
  sender: string;
}

const qty = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

/** A short reference a supplier can quote: the last six characters of the order's id. */
export function orderRef(id: string): string {
  return id.replace(/-/g, '').slice(-6).toUpperCase();
}

export function orderSubject(m: Pick<OrderMessage, 'store' | 'ref'>): string {
  return `Order ${m.ref} from ${m.store}`;
}

/** The order as plain text, one line per item; prices and a total only when asked. */
export function orderText(m: OrderMessage): string {
  const lines = m.lines.map((l) => {
    const base = `• ${l.name}: ${qty.format(Number(l.qty))} ${l.unit}`;
    return m.prices ? `${base} at ${money.format(Number(l.unitCost))} a ${l.unit}` : base;
  });
  const total = m.lines.reduce((t, l) => t + Number(l.qty) * Number(l.unitCost), 0);
  return [
    `${orderSubject(m)}`,
    `To: ${m.supplier}`,
    `Date: ${m.orderedOn}`,
    '',
    ...lines,
    ...(m.prices ? ['', `Total: ${money.format(total)}`] : []),
    '',
    `Please confirm the delivery date. ${m.sender}`,
  ].join('\n');
}

/**
 * The number as WhatsApp wants it: country code and digits only. A 10-digit Indian mobile
 * gets 91; a leading trunk 0 is dropped. Null when there is no usable number.
 */
export function whatsappNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

export function whatsappLink(phone: string | null | undefined, text: string): string | null {
  const n = whatsappNumber(phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}

export function mailtoLink(email: string | null | undefined, subject: string, body: string) {
  if (!email) return null;
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
