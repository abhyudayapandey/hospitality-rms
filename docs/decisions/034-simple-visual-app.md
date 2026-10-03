# 034 — A simple, visual app for each role (UX-6)

Status: accepted · 2026-10-03

Prospect feedback: most people in the industry read little, so the app must be simpler and
more visual. We walked the app as twelve roles and published mock-ups for review
(docs/ux-review.md, UX-6). They were approved: "The screens look much better now". This
change builds them. Migration `20261026100000_item_photos`.

## The decisions

1. **The look.** All icons are drawn line icons (`components/icon.tsx`, inline SVG, no
   package), with one stroke and the colour of their text. There is one brand colour, a
   deep teal (`--color-brand-*` in `globals.css`), used for primary buttons, the active tab
   and chosen chips. Colour carries status only:
   - emerald: done;
   - amber: due soon;
   - rose: needs you now.

   No emoji, no fonts to download, nothing playful.

2. **Three to five tabs, everything else on Me.** The bottom nav follows the mock-ups:

   | Kind of work        | Tabs                                          |
   | ------------------- | --------------------------------------------- |
   | Frontline           | Home, Tasks, Me                               |
   | Store keeper        | Home, Stock, Tasks, Me                        |
   | Department head     | Home, Roster, Stock (else Tasks), Reports, Me |
   | GM, area manager    | Home, Approvals, Reports (else Stock), Me     |
   | Cost controller     | Home, Stock, Reports, Approvals, Me           |
   | HR, owner, auditors | Home, Approvals, Reports, Admin or Roster, Me |

   **Me** (`/me`) lists the person's own things (shifts, clock, leave, swaps, my week,
   requests, approvals, notifications, profile), then every other screen they can open, as
   tiles. Sign out is there too. Approvals ("Inbox" before) sits in the header for anyone
   without the tab, with its count. Home's shortcuts and "All screens" are gone: Me
   replaces them.

3. **Home by role.**
   - Everyone with a shift gets one card with the shift and one big **Clock in** or
     **Clock out**.
   - Frontline staff see the **next job** with a Start button. Below it are **four tiles**,
     each with a count: their tasks, then Make, the store they keep, their shifts, leave,
     or "Report a problem", whichever four come first.
   - The **store keeper** has four tiles:
     - Receive: orders not yet received in full;
     - Send: transfers waiting to go out;
     - Running low;
     - Count.
   - **Leads** see:
     - the expiry banners;
     - **Needs your yes**: the first three approvals, with **Approve** and **No** right on
       Home where the decision belongs there, else Review;
     - **Needs attention**: one line per department, with a red or amber bar and a count;
     - today's figures **against the company's targets**, red only when more than 2
       points off (ADR 031).
   - Over two or more outlets (area manager, owner), Home shows the outlets side by side
     for the last 7 days instead.
4. **"Running low", not "below par".** An item is low when it has none left, or when it is
   below its level and lasts three days or fewer at what the store used over the last 14
   days. An item below its level that the store hardly uses is not low. When 14 of 16 items
   were "below par", nothing stood out. The rule is in `lib/low-stock.ts` (unit tested). The
   same rule counts low items on Home.
5. **One job per screen.** Whoever works a task with several steps sees its progress bar,
   what is done, and only the step to do now; the rest are named below. Anyone else (a lead
   checking) sees every step.
6. **Plain words.** Throughout:
   - "Make", not "Production";
   - "Running low", not "below par";
   - "keep 2 kg", not "par";
   - "Approvals", not "Inbox";
   - "attendance issues" and "open shifts", not "flags" and "slots".
7. **Item photos.**
   - Each item can have a photo, which shows on the stock list and the item screen. Until
     it has one, a drawn icon for its kind stands in (produce, drinks, linen, prep, meat and
     dairy, else a box).
   - Anyone who records stock changes (STOCK_ADJUSTMENTS modify) at a store that carries
     the item can add, change or remove the photo, with the phone camera, on the item
     screen.
   - Photos live in the photo bucket under `items/<tenant>/<item>/`, with no lifecycle
     rule: they are kept as long as the item.
   - Loading photos from file 10 waits for an onboarding format that can carry images.

## How it works

- `lib/nav.ts`: the profiles and the tabs. `lib/screens.ts`: every screen with its icon and
  the rule for showing it, for Me and the tiles. The rules come from the person's domain
  access (`core.my_domains()`), never a check of their own (rule 2). The pages and the
  database still refuse anything else.
- `lib/today.ts` reads Home's cards in one transaction, each under RLS:
  - `wf.my_inbox()` for approvals;
  - `inv.purchase_order_summary` and the ledger for the store keeper;
  - `inv.expiry_list(3)` for the banners;
  - `rpt.league` for outlets side by side;
  - `core.company_settings()` for the targets.

  The Approvals screen and Home share `lib/inbox.ts`.

- **Item photos.**
  - `inv.item.photo_key`, with a check that the key is the company's and the item's own.
  - `inv.can_set_item_photo(item)`: an item of the person's company, kept at a store where
    they hold STOCK_ADJUSTMENTS modify.
  - `inv.set_item_photo(item, key)`: refuses NOT_AUTHORISED or INVALID_PHOTO. Set, change
    and clear are all audited by `inv.item`'s audit trigger.
  - The app signs an upload only after `can_set_item_photo` says yes. The instance role
    gains put and get on `items/*` (CDK, `ItemPhotos`), with no delete: a new photo takes
    a new key.

## Not in this change

- A first-run tour of three pictures per role.
- Recipe step photos.
- Making a batch step by step.
- "Push today" for servers (INV-12, a later change).
- The stock check tile, which replaces Count with INV-10.
- Trying the app with real staff (UX-6 step 5) happens at the pilot.

## Tests

- `item-photos.db.test.ts` (written first) covers:
  - set, change and clear by a chef, with audit;
  - refusal for a commis, a server and HR;
  - no direct writes;
  - nothing across companies;
  - only the item's own key.
- Unit tests:
  - `screens.test.ts`: tiles and Me per role;
  - `low-stock.test.ts`;
  - `unit.test.ts`: the tabs table;
  - `today-view.test.ts`: tone and totals.
- CDK: the instance role's photo rights include `items/*`.
- e2e:
  - `nav.spec.ts`: every role's tabs, Me, the header's Approvals, and three to five tabs
    for everyone in both test customers;
  - `journeys.spec.ts`: tap counts;
  - plus the Home, sign-out and Make changes in `reports`, `tasks`, `place-switcher`,
    `production` and `signout`.
