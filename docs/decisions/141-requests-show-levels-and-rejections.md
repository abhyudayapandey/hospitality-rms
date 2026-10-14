# 141. Requests show what each store has; a "no" reads as rejected; running low is under par

Date: 2026-10-14. Status: accepted. Migrations `20261227100000_request_levels`,
`20261227110000_buy_for_request`.

## Context

The functional QA walk of [TEST] Restaurant (the per-person checklist) found these:

1. The GM approving a request saw only what was asked and the usual amount. They could not see
   what the asking department already has against its par.
2. When a head can't give what a frontline person asked for, it showed as "Done", and the asker
   also got "Done: ...". It should read as rejected, with the reason.
3. The bar short of limes asked the Main Store, which doesn't keep limes. "Buy what's short" was
   refused ("That item isn't set up for this location"), so the request was stuck.
4. "It arrived: give it" showed as soon as the head asked the Main Store, before anything arrived.
5. "usual 12.107 bottle a week": three decimals.
6. "Give it" was offered when the store had less than asked.
7. "Running low" counted days of use left, not par (ADR 034). The Main Store showed one item
   running low while five were under par.
8. A repair read "assigned with Santosh Naik".

## Decision

1. **What each store has** (`inv.request_levels`): per line, what the giving store has, and what
   the asking store has of its par. It is shown on the GM's approval card on Home, and on the
   request's page until it is sent. Whoever may follow the request (`inv.may_follow`) or holds
   its step may read it; nobody else. The head's page for a frontline ask also shows the store's
   par.
2. **Rejected, with why.** The head's task stays done (it is dealt with), but `ops.my_tasks` and
   `ops.my_handed_on` carry `not_given_reason`. The lists say "Rejected by <head>: <reason>"
   and a red "Rejected". The asker hears it from the ask itself ("Not given: ...", or "Ready
   for you" when given). The head's ask task no longer sends "Done: ..." as well.
3. **The Main Store buys for the stores that ask it.** When its keeper buys what is short for a
   request (`inv.order_for_request`), the Main Store starts keeping what it didn't (par 0, the
   asking store's usual supplier). The order, its receipt and the send then work as for any
   item.
4. **Arrived.** An ask the head passed on reads `arrived` (`inv.ask_arrived`) once everything
   it waited on came in. Only then does the page offer "It arrived: give it"; before, it says
   "Give it once it arrives".
5. Quantities in an approval's words have at most 2 decimals.
6. A short store's ask offers "Short: ask for it" first, and no "Give it".
7. **Running low is under par** (replaces ADR 034's rule). Each line under par reads
   "14 of 20 kg (~1 day left)": what is left of the par, then how long it lasts at the last
   two weeks' rate. Home counts the same.
8. A repair reads "with Santosh Naik", or "Santosh Naik is on it" once started.

## Consequences

- More items show as running low on Home and Stock than before; each says how long it lasts,
  so the urgent ones still stand out.
- A Main Store's item list grows by what it buys for others, at par 0. Its keeper may set a
  par for it, or archive it.
