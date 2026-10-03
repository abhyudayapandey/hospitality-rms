# 032 — Sending an order to its supplier (PO-4)

Status: accepted · 2026-10-03

PO-4 in the PRD, built with R-4 (ADR 031) in one change.

## The decisions (3 Oct)

1. **Quantities only by default.** A company setting (`po_send_prices`, Admin → Targets
   and settings) adds the agreed prices and the total.
2. **Whoever runs the orders keeps the supplier's contact up to date**, and every change
   is audited.
3. **No email from the server.** The AWS Free plan has no SES. The app opens WhatsApp
   (`wa.me`), the mail app (`mailto:`) or a printable page on the person's own phone, and
   records the send on the order.

## How it works

- **The supplier's contact.** `inv.supplier` gains `phone` for WhatsApp; `contact` stays
  the email. `inv.update_supplier_contact` lets anyone with PURCHASE_ORDERS modify at one
  of the company's stores change them; blank clears one. The phone must have 8 to 15 digits
  and the email must look like one, else `INVALID_CONTACT`. A supplier is shared by the
  company's stores (it is a catalog row), so a change applies to all of them. The audit
  trigger on `inv.supplier` records who changed what.
- **Sending.** A released order shows "Send to supplier" to the people who run the store's
  orders: WhatsApp (when the supplier has a phone), Email (when it has an email) and Print.
  Each button records the send (`inv.record_po_send`), then opens the app or the printable
  page. The message names the store, the supplier, a short order reference (the last six
  characters of the order's id), the date, each item and quantity, and who sent it.
- **What is recorded.** `inv.po_send`: the order, the store, the channel, who and when.
  It is insert-only, has RLS on PURCHASE_ORDERS at the store and is audited. The order
  page lists the sends ("Sent on WhatsApp by …, 2 min ago"), read through `inv.po_sends`.
- **Refused:**
  - an order not yet released (`INVALID_STATE`);
  - another channel (`INVALID_CHANNEL`);
  - anyone without PURCHASE_ORDERS modify at the store (`NOT_AUTHORISED`).
- **What a recorded send means.** The person opened WhatsApp, the mail app or the print
  page, not that the supplier received anything. The screen says "Sent … by" and nothing
  more.
- **Phone numbers.** A 10-digit Indian mobile gets the country code 91; a leading 0 is
  dropped.
- **Onboarding.** File 09 gains an optional `contact_phone`. A blank email or phone in the
  file keeps what was set in the app, so a re-import does not undo a store keeper's edit; a
  value in the file replaces it.

## Tests

- `po-send.db.test.ts`:
  - every user may send exactly when they hold PURCHASE_ORDERS modify at the store;
  - sends are recorded, listed with the sender's name and audited;
  - a bartender sees none;
  - an order not released, a bad channel and a direct insert are refused;
  - contact edits for every user against the rule, audited;
  - bad phones and emails, and another company's supplier, are refused.
- `loader.db.test.ts`: a bad phone is reported by file, row and column; a blank one keeps
  the app's value.
- Unit (`po-message.test.ts`): the message with and without prices, WhatsApp numbers, the
  `wa.me` and `mailto:` links.
- e2e: the executive chef sends the Dairy & Poultry order on WhatsApp (quantities only),
  sees the send listed, prints it, and gets a clear message for a bad phone.
