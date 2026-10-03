import { describe, expect, it } from 'vitest';
import {
  mailtoLink,
  orderRef,
  orderText,
  whatsappLink,
  whatsappNumber,
  type OrderMessage,
} from './po-message';

const order: OrderMessage = {
  store: 'Test Hotel & Bar 1.0 – Kitchen Store',
  supplier: 'Test Supplier – Dairy & Poultry',
  ref: orderRef('01a10115-5a16-726c-ba11-1b706b4fc0d5'),
  orderedOn: '2026-09-30',
  lines: [
    { name: 'Paneer', qty: '5.000', unit: 'kg', unitCost: '380.0000' },
    { name: 'Milk', qty: '20', unit: 'l', unitCost: 60 },
  ],
  prices: false,
  sender: 'Test Executive Chef 1.0',
};

describe('the order message', () => {
  it('quantities only by default: no prices, no total', () => {
    const t = orderText(order);
    expect(t).toContain('Order 4FC0D5 from Test Hotel & Bar 1.0 – Kitchen Store');
    expect(t).toContain('• Paneer: 5 kg');
    expect(t).toContain('• Milk: 20 l');
    expect(t).not.toContain('₹');
    expect(t).toContain('Test Executive Chef 1.0');
  });

  it('with the setting on: each price and the total', () => {
    const t = orderText({ ...order, prices: true });
    expect(t).toContain('• Paneer: 5 kg at ₹380.00 a kg');
    expect(t).toContain('Total: ₹3,100.00');
  });
});

describe('links', () => {
  it('WhatsApp numbers: country code and digits only', () => {
    expect(whatsappNumber('+91 98200 10002')).toBe('919820010002');
    expect(whatsappNumber('98200 10002')).toBe('919820010002');
    expect(whatsappNumber('098200 10002')).toBe('919820010002');
    expect(whatsappNumber('+44 20 7946 0958')).toBe('442079460958');
    expect(whatsappNumber('12345')).toBeNull();
    expect(whatsappNumber(null)).toBeNull();
  });

  it('wa.me with the text; mailto with subject and body; none without a contact', () => {
    expect(whatsappLink('+91 98200 10002', 'a b&c')).toBe(
      'https://wa.me/919820010002?text=a%20b%26c',
    );
    expect(whatsappLink(undefined, 'x')).toBeNull();
    expect(mailtoLink('orders@dairy.example', 'Order 1', 'Paneer: 5 kg')).toBe(
      'mailto:orders%40dairy.example?subject=Order%201&body=Paneer%3A%205%20kg',
    );
    expect(mailtoLink('', 's', 'b')).toBeNull();
  });
});
