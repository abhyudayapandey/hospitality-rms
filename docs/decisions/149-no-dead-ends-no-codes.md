# 149. No dead ends, no codes on screen

Date: 2026-10-15. Status: accepted. Migrations `20261231100000_ask_the_outlets_stores`,
`20261231110000_place_names_in_words`.

## Context

The re-audit (sections 3 and 4) found screens that open on "You don't ..." and words only the
system uses:

1. **Running low rows that won't open.** An item's page offered "Request more" from a grant the
   person held somewhere else, then asked the store for it and failed: "We couldn't open this".
2. **Tiles to empty screens.** Excise, Audits, Utilities, Sales, Opened packs, My SOPs and Roster
   showed as tiles to people who had nothing there. Cost of sales linked the account owner to
   "Count the stock", which they can't open.
3. **RFMs with nowhere to ask.** RFMs opened on "Your team has no store to ask" for the GM, the
   account owner and the Solo Bar's floor team, who couldn't ask the bar for limes or straws.
4. **A broken dish photo** when its file was gone.
5. **Codes on screen.** An item's page showed `sales_depletion`, `production_in` and the item's
   code. The user page read "from 2025-09-17 · job_role · job role default (bar_pub)", status
   "active"; the access audit "user created", "by Platform", "Ai agent". Places read "Test Solo
   Bar – Supply Point" and "Housekeeping Store (with the in-room minibars)"; Your plan read
   "Supply requests & orders", "Supply Viewer", "par levels".

## Decision

1. **What a page offers is checked at its place.** The item page asks `core.can` at the store
   before it offers "Request more"; without it, the page opens with no button.
2. **A tile shows only when its screen has something for the person** (`Shell.nothing`): each
   screen's own list (`inv.excise_stores`, `ops.audit_places`, `ops.utility_places`,
   `ops.my_sops`, `core.screen_places` for opened packs, roster and sales) is asked once, with
   the other nav checks, and a screen with nothing is left out of Me and Home. "Count the
   stock" shows only to those with a store to count.
3. **RFMs's Request tab goes where the person can ask** (`rfmRequestHref`): the ask form for
   whoever has a store to ask; Request from a store for a manager who may request for one; no
   Request tab otherwise. **A department with no store asks its outlet's stores**
   (`inv.my_ask_stores`), and the ask goes to that store's head as any other. Whoever sits at the
   outlet (the GM, the account owner) is unchanged.
4. **A photo that doesn't load shows the library picture** it would have had (`PhotoOrPicture`).
5. **Words, not codes.** Every ledger movement has a word (`movementLabel`: Sold, Made, Used to
   make), and an item's page shows no code. Access rows read "since 17 Sept 2025 · comes with
   the job"; status Active or Not active; the access audit "Person added", "Access given", "by
   the Outlet Ops team"; the AI agent is the "Outlet Ops assistant". An outlet's stock place is
   "<outlet> stores" (templates, onboarding files, and a migration for places already loaded);
   a store's name holds no note in brackets. Your plan: "Requests and orders", "Stock viewer",
   "par".

## Not in this decision

Swaps for managers only (the user's decision on the audit's B4) changes the swap flow and its
tests; it follows in its own PR.

## Consequences

- No tile, tab or link opens on "You don't ...". A new screen whose list can be empty joins
  `EMPTY_CHECKS` in `lib/shell.ts`.
- A floor team can ask for what it needs without a manager in between.
- Re-importing a customer whose files still say "– Supply Point" renames its place back; the
  test customers' and demos' files are updated.
