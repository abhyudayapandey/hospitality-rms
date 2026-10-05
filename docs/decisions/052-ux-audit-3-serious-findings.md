# 052 — UX audit 3: the serious findings, and dark by default

Status: accepted · 2026-10-05 (migration 20261110100000)

UX audit 3 (`docs/ux-audit-3.md`) found 12 things, F1 to F12, that were wrong or misleading,
or that blocked a daily job. The user decided:

- a department sees its Main Store orders "on the way" with no ₹;
- the keeper closes an order whose rest is not coming, and the GM is told;
- a request to the Main Store is a "Supply request" everywhere.

The user also asked for a dark/light switch, with dark as the default.

## Decision

1. **The keeper's work is counted where they look (F1).**
   - The To do list badge counts the order desk's requests to order and orders to receive
     (`inv.desk_orders()`), which the To do list already listed.
   - Home's store tiles start with **To order · N** when there are any. It opens Orders on To
     order.
2. **The Stock screen puts the list first (F2).** Its jobs come after the list.
   - A department's store: Count, Record wastage, Ask for supplies, Request stock.
   - The Main Store: Send stock, Count, Record wastage, with Ask for supplies and Request
     stock as small links (ADR 051).
3. **Running low says what to do (F3).**
   - On the Running low tab, each store the person may order for gets **Ask for these** (the
     Main Store: **Order these**), opening a supply request.
   - On Home, the line's verb is **Order** only for someone who may order. View-only roles get
     **See**.
4. **Money is what was paid (F4).** Bills → Waiting for a bill shows "received for ₹X", from
   the receipts, never the order's estimate.
5. **Counts are the whole list (F5, F12).**
   - Transfers' To send counts what it lists: waiting to be sent from these stores.
   - Orders and Transfers count each tab in SQL with no limit, then list 30 at a time with
     **Show more** (`?n=`, `lib/list-page.ts`).
6. **Receiving a transfer fills nothing in (F6).** As with Send stock, the person enters what
   arrived ("0 if nothing"). **Everything arrived** fills what was sent. A shortfall is
   counted, not assumed away.
7. **The order desk sends what it placed (F7).**
   - The Main Store's keeper sends the order to its supplier (WhatsApp, email, print), sees
     the sends, and keeps the supplier's contact. `inv.record_po_send` and `inv.po_sends`
     also accept `inv.can_place`.
   - The department that asked does not send it.
8. **A department follows its Main Store order (F8).**
   - An order its Main Store places and receives (`inv.via_desk`) shows "on the way · due
     <date>", "part arrived" and "arrived" (`SUPPLY_PROGRESS`). The department's tab is **On
     the way**.
   - The department gets no receive form and no ₹, and `inv.receive_goods` refuses it
     (`NOT_AUTHORISED`).
   - The department still sees **Bill missing**.
9. **Closing and withdrawing (F9).** Neither changes the order's status column (rule 4):
   `purchase_order.closed_at`, `closed_by` and `close_reason` mark both, and the summary's
   progress reads `closed` or `withdrawn`.
   - **Rest is not coming** (`inv.close_order(po, reason)`): the keeper who receives the order
     closes it. The reason is required (`REASON_REQUIRED`).
     - What arrived stays. Nothing more can be received (`INVALID_STATE`).
     - It leaves the desk's lists.
     - The outlet's GMs, whoever asked, and the store's people are told.
     - The GM can close an order too, since they hold every access, but the keeper is the one
       who answers for it.
   - **Withdraw** (`inv.withdraw_request(po)`): whoever asked withdraws a request that nobody
     has ordered yet. If it is waiting for approval, its workflow request is cancelled
     (`wf.act` cancel, the initiator's own right), so it leaves the approver's list.
10. **Things I asked for (F10).**
    - Every row opens, leave and swaps included.
    - A supply request shows its items and where it is, in the department's words, with no ₹.
11. **A technician's repairs reach Home (F11).**
    - Repairs assigned to the person and not done are listed in Next, and counted on the Tasks
      tile.
    - Tasks lists first, with New task and Report a problem after the list.
12. **Naming.** A request to the Main Store is a **Supply request** on every screen.
13. **Dark by default.**
    - The light palette's scales are turned over under `html[data-theme='dark']`
      (`app/globals.css`):
      - the page is the darkest surface;
      - cards (`bg-white`) are one step up;
      - text is the lightest;
      - status tints keep their meaning.
    - Every screen follows its light design's contrast with no per-screen classes.
    - The sun/moon button right of Notifications switches the theme.
      - The choice stays on the device (localStorage).
      - It is applied by a one-line script in `<head>` before the first paint, so the page never
        flashes the other theme.
      - Nothing reaches the server.

14. **The DB test shards finish together.**
    - In CI, one DB shard ran on for about 3 minutes after the other was done: about 7.5
      minutes against 4.5. Both shards start together, so nothing runs in sequence. The
      shards were uneven.
    - `packages/db/test/sequencer.ts` balances the shards by each file's expected seconds.
      Those weights dated from 2026-10-03, and had drifted.
      - The heaviest files all landed on shard 2: RLS equivalence (now about 250 s) and the
        report refusals (about 330 s).
      - Measured as CI runs them, that was 415 s against 189 s.
    - **The fix:**
      - The refusals run as two files, half the people each.
      - The weights are re-measured. The expected loads are 585 s and 582 s, about 5 minutes a
        shard.
      - A unit test (`sequencer.test.ts`) fails when a weight names a missing file, or one
        file takes more than a third of the total.
      - Each DB shard in CI ends with a **DB test times** step. It prints every file's
        seconds on CI's own machines as lines ready to paste into the weights table
        (`packages/db/test/print-times.mjs`). Local timings differ too much to use: on the
        first push, the weights measured locally sent shard 1 to 412 s and shard 2 to 155 s.
        The weights now come from CI's numbers.

## Not done here

The audit's P2 and P3 items (F13 to F26 and the polish list) are a separate PR.
