# 053 — UX audit 3: the friction (P2) and polish (P3) findings

Status: accepted · 2026-10-05 (migration 20261111100000)

ADR 052 fixed the audit's serious findings (F1 to F12). This ADR covers the rest of
`docs/ux-audit-3.md`: F13 to F26 and the polish list.

## Decision

**Asking for and sending stock**

1. **Ask for supplies fills nothing in (F13).** Each line says what the store has and keeps:
   "have 3 · keep 10 kg". **Fill to keep level** fills the short items, using the quantities
   the form used to suggest.
2. **Each form says where the goods come from (F14, F26).**
   - **Ask for supplies** is for things bought from a supplier. It names who orders them: the
     outlet's Main Store (`inv.order_desk_name`), or "You order it here" for a store with no
     Main Store, or for the Main Store itself.
   - **Request stock** is for stock another store already has: it is sent from their shelves.
   - Each form points to the other.
3. **Send stock shows the department (F15).**
   - Each line shows what the department has and keeps: "Kitchen Store has 2 · keeps 10"
     (`inv.send_items`, two more columns).
   - Its short items come first in their group, in red.
   - **Fill to keep level** brings each short item up to its keep level, at most what the
     Main Store has (`lib/send-keep.ts`).
   - The empty text says there is nothing in stock to send.
4. **The Main Store's Transfers opens on To send, 10 at a time (F16)**, so Send stock is near
   the top. **All** is one tab away. Sending stock returns to All, to show what was sent.
5. **Ordering and receiving name money the same way (F20).**
   - Placing an order asks for the "expected price per kg (optional)".
   - Receiving asks for the "Bill amount, total (₹)" and shows "= ₹40.00 per kg".
6. **Mark as ordered (F21).**
   - The button says what it does: **Mark as ordered**.
   - Its delivery date counts from the phone's calendar, not UTC's. Before 05:30 in India,
     UTC's "tomorrow" is still today.

**Lists and Home**

7. **Back keeps the list (F17).** Orders and Transfers pass their own address to the detail
   page (`?back=`, `lib/back.ts`). "← Orders" returns to the same tab and "All stores".
   - Only a path inside the app is followed: never another site.
   - A desk order's back link goes to the keeper's own store (ADR 052).
8. **The keeper's Home says each thing once (F18).**
   - Running low is the tile only. It is no longer repeated in Do these first or Needs
     attention.
   - The **Count** tile says "Last counted N days ago" or "Never counted here". It is marked
     **due** when the oldest store's count is due (`count_due_days`, ADR 035).
9. **Approvals show what was asked for (F19).**
   - A supply request on Home and in the To do list names its items ("Test Onions 2 kg") and
     why it needs approval.
   - Its money reads "about ₹", because it is the last price paid. The GM's notice of a new
     order says the same.
10. **Four supply tabs, the rest under More (F24)** (`lib/supply-tabs.ts`).
    - The tabs come in the order a store works: Stock, Orders, Transfers, Count, Wastage, Make,
      Stock check, Bills.
    - The tab you are on is always shown.
    - A single extra tab is not hidden under More.
11. **Lists before actions on the rest of the screens (F25).**
    - Stock check and Count show a check or count already started first, because it is what
      to do now. Otherwise the list comes first, then Start.
    - Leave shows the balances and requests first, then the form.

**Words**

12. **One name each (F22).**
    - **Supply request**: ask the Main Store to buy.
    - **Stock request**: from another store's shelves.
    - **Request for material**: TR-3, unchanged.
    - **Stock check**: the verifier's blind check, the tab once called "Check". **Count** is
      the store's own count.
    - **Reject**: never "No".
    - **waiting for approval** and **waiting to be sent**: never "awaiting".
13. **The league table's dot says why (F23).** Under the outlet's name, it shows "food cost
    38%, target 32%" or "people 30%, target 28%". Food cost is not one of the columns, so the
    dot alone could not be explained.

**Polish (P3)**

14. Dates read "Tue, 7 Oct", not "2026-10-07".
15. A request's step reads "needs your approval", "to send" or "to receive", never its code
    (`lib/request-words.ts`). "Top of chain" reads "Approved at once: nobody above you approves
    this."
16. Bills' count and total cover every bill in the tab, not only the 50 shown.
17. Transfer rows name their items. The store names are short when one store is chosen
    ("Kitchen Store"); under All stores they stay full, since two outlets can each have a
    Kitchen Store.
18. "You don't have access to stock" has a way back to Home.
19. **Reject asks why and is confirmed.** A transfer's Reject sits next to Send or Approve, so
    it opens a "Why is it rejected?" box with Keep it and Reject. The reason is kept on the step
    (`wf.act` comment).
