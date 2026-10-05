# UX audit 3: findings by role (draft for review)

Status: **P1 (F1 to F12) built in ADR 052; P2 and P3 (F13 to F26, polish) built in ADR 053.** Draft of 5 Oct 2026. These findings come from a code-and-copy review at commit f581899.
Live screens could not be checked in this run, so nothing visual (layout and truncation at
380 px) is covered. Each finding names the file to change.

## P1: wrong, misleading, or blocks a daily job

| ID  | Who                                                         | What's wrong                                                                                                                                                                                             | Fix                                                                                                                         |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| F1  | Main Store keeper                                           | The To do list badge and Home leave out the requests the keeper must order. A new kitchen request shows a badge of 0 and appears nowhere on Home (`lib/shell.ts`, `lib/today.ts`, `app/(app)/page.tsx`). | Count the requests to order and to receive in the badge. Add a first Home tile, "To order · N", opening Orders on To order. |
| F2  | Main Store keeper, department stores                        | Stock leads with action tiles, Request stock among them, and has no Send stock (`stock/page.tsx`, `lib/stock-hub.ts`).                                                                                   | On the Main Store: Send stock and Count tiles, and Ask for supplies as a small link. The list comes first everywhere.       |
| F3  | GM, Sous Chef, Cost Controller, Area Manager, Owner, keeper | Home's "N items running low · Order" opens Stock → Running low on All stores, which has no button to order (`lib/today-view.ts`, `stock/page.tsx`). It is offered to view-only roles too.                | The verb depends on the role (Order / Ask the Main Store / See). Add an "Order these" or "Ask for these" link per store.    |
| F4  | GM, Cost Controller, keeper                                 | Bills → Waiting for a bill shows the order's estimate as money (`stock/bills/page.tsx`).                                                                                                                 | Show "received for ₹X", from the receipts.                                                                                  |
| F5  | Store keepers                                               | Transfers "To send (n)" counts incoming requests, then lists only outgoing ones (`transfers/page.tsx`).                                                                                                  | Count with the same filter as the tab.                                                                                      |
| F6  | Department staff                                            | Receiving a transfer is pre-filled with what was sent (`transfer-step-form.tsx`), so a shortfall is never caught.                                                                                        | Use the Send stock pattern: empty fields, "Everything arrived", "0 if nothing".                                             |
| F7  | Main Store keeper                                           | The keeper who picked the supplier can't send the order to it by WhatsApp, email or print. The requester (the chef) can (`orders/[id]/page.tsx`).                                                        | Give send and contact to the order desk; hide them from requesters.                                                         |
| F8  | Exec Chef, Bar Manager, Exec Housekeeper                    | They get the receive form, with ₹ required, for orders the Main Store receives. They see "To receive" and "Received for ₹" on their own requests.                                                        | For a desk order the department sees "On the way · due date", no form and no ₹. Rename their tab "On the way".              |
| F9  | Everyone who orders                                         | There is no way to close an order that will never arrive, or to withdraw a request. Short or never-delivered orders stay in To receive forever.                                                          | "Rest is not coming" (with a reason) closes it; "Withdraw" on a request still to be ordered.                                |
| F10 | Dept heads, supervisors                                     | "Things I asked for" shows workflow states ("completed" while still to be ordered) and estimates in ₹. Leave and swap rows don't open (`requests/page.tsx`).                                             | Show the order's progress and its items, no ₹, and link every row.                                                          |
| F11 | Technician                                                  | Repairs never reach Home. "Nothing due today" shows with two repairs assigned (`app/(app)/page.tsx`, `tasks/page.tsx`).                                                                                  | Include assigned repairs in Next and in the badge.                                                                          |
| F12 | Keeper, GM                                                  | Orders counts only the newest 60 of the store's own orders, while Home's count has no limit. Transfers stops at 30.                                                                                      | Count in SQL with no limit; limit only the lists, with "Show more".                                                         |

## P2: friction and confusion

| ID  | What's wrong                                                                                                                  | Fix                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| F13 | Ask for supplies is pre-filled with suggested quantities that have no label.                                                  | Empty fields; "Have 3 kg · keep 10 kg"; a "Fill to keep level" link.                                |
| F14 | Two ways to get goods (Order = buy, Request stock = from the Main Store), and nothing says which to use.                      | Label them by source, or one "Ask for stock" in which the keeper decides whether to send or to buy. |
| F15 | Send stock doesn't show what the department has, keeps, or is running low on. The empty-list text is stale.                   | "Kitchen has 2 kg · keeps 10 kg"; their running-low items first; "Fill to keep level".              |
| F16 | Send stock comes after up to 30 history cards.                                                                                | Open the Main Store on To send; latest 10, then "Show more".                                        |
| F17 | Back links drop the tab and "All stores". A desk order's back link goes to a store the keeper can't open.                     | Carry the list URL into the detail page for "← Back".                                               |
| F18 | The keeper's Home repeats running low three times. Count has no "due" note.                                                   | Tiles only for the store profile; Count says when it is due.                                        |
| F19 | Approving on Home shows "Purchase order ₹estimate" with no items.                                                             | Show the items and why; call it "Supply request".                                                   |
| F20 | Place order asks a price per unit; Receive asks the line total.                                                               | "Bill amount for this item (₹ total)", then "= ₹40/kg".                                             |
| F21 | The Place order button says "Ordered". Its default date uses UTC (in IST before 05:30, "tomorrow" is today).                  | "Mark as ordered"; dates from the outlet's local day.                                               |
| F22 | One thing has several names: supply request, transfer request, Count / Check, No / Reject, awaiting / waiting for approval.   | Pick one name each.                                                                                 |
| F23 | The league table's dot follows figures that are not in the columns.                                                           | Make the dot follow what is shown, or name the reason.                                              |
| F24 | Up to 8 supply pills push the content down.                                                                                   | 4 per role, the rest under "More".                                                                  |
| F25 | Actions still come before the information on Tasks, Stock check and Leave; on Count the open count sits below the old counts. | List first, then the actions; an open count goes first.                                             |
| F26 | The Ask for supplies text is wrong on the Main Store itself and at outlets with no Main Store.                                | Say who actually orders it.                                                                         |

## P3: polish

- Raw ISO dates ("due 2026-10-07").
- The raw step shows in the To do list; "top of chain" is jargon.
- "50 bills · ₹X" totals only the latest 50.
- Transfer rows don't name their items, and their headers repeat long store names.
- "You don't have access to stock" has no way back.
- The GM's order notification should say "about ₹".
- Reject sits next to Send on a transfer with no confirm and no reason.

## Not covered

Events, Admin, the inside of Reports, clock-in and selfies, and anything visual at 380 px. All
of these need a live run.
