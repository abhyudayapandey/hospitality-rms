# 085 — Building blocks: every group of functionality can be in or out

Status: accepted · 2026-10-09 · migration 20261210100000

The Passport Hotel pilot shared 38 of its own and its reference documents. Much of what they
need (two signatures, registers, linen, audits, training, excise) is what nearly every hotel
needs, so it belongs in the product; and not every customer wants everything. The product is
sold, and built, as building blocks: each group of functionality is added to or taken out of a
customer's plan. The plan for this and the next three PRs is `docs/plans/building-blocks.md`.

## Decision

1. **Every group of functionality is a block** (a module switch, ADR 026, in the code and the
   database; a block to people), with a manifest in `packages/domain/src/modules.ts`: name,
   one plain line, the bundle it is sold in, the blocks it **needs**, the outlets it **fits**
   (any, hotel, alcohol), the access **domains** it owns and whether it is on by default. New
   blocks for what had no switch: Stores & stock, Supply requests & orders, Recipes & costing,
   Roster, Clock-in, **Salaries & labour cost**, Today's briefing and Room minibars.
2. **The base has no switch**: places and people, access, To do, approvals, notifications,
   Home, Me, Admin, onboarding and the reports shell (`BASE_DOMAINS`). Every access domain
   belongs to exactly one block or to the base; a test checks it.
3. **Bundles regrouped** (ADR 067): Stock & buying, Kitchen & bar, People, Daily work, Hotel
   (out of a plan unless put in) and Events & compliance. A block needs others only in its own
   bundle or in Stock & buying.
4. **On** means switched on (or on by default: every block but Compliance), its bundle in the
   plan, and every block it needs on (`core.tenant_modules`, one read of the customer's
   settings).
5. **Off means gone, data kept.** `core.can` says no to a domain whose block is off
   (`core.domain_module`). RLS builds on `core.can` (ADR 007), so the block's rows disappear and
   every function that checks access refuses, with no change to them. Screens hide the block
   through the same domains (`lib/modules.ts`), its pages say it isn't switched on
   (`ModuleGate`), its server actions still call `requireModule` for a clear `MODULE_OFF`. The
   nightly attendance exceptions skip a customer without Clock-in; checklist rounds,
   compliance reminders and expiry alerts already skipped theirs. A request already waiting
   for approval in a switched-off block can't be decided until it is back on.
6. **Only platform admins change configuration.** `core.set_module`, the Account Owner's
   switch, is gone. `platform.set_module` switches one block (only inside a bundle in the plan,
   `NOT_IN_PLAN`), `platform.set_bundle` puts a bundle in (every block in it on: what was sold)
   or out, both in the platform audit. The console's customer page has a card per bundle with a
   switch per block; file 00 has a column per block (blank keeps it). Admin → **Your plan**
   shows the plan read-only to the company's administrators.
7. **Salaries & labour cost** (inside People, on by default) is the switch for a customer who
   won't share pay. Off: COMPENSATION and LABOUR_COST are refused, no pay rates are loaded
   from file 34 (the dry run says so), and `rpt.labour_cost_of`, through which every labour
   figure goes, gives nothing: labour cost is 0 and the total cost is materials only, the same
   in every report, past days included.
8. **The set-up wizard** ticks bundles on "What they buy" as before; ticking one switches every
   block in it on at go-live, Compliance included.
9. **Every customer keeps what it has.** The migration translates the old bundles (Stock &
   cost, People & roster, Tasks & food safety, Compliance) into switches, puts Hotel in for
   customers with rooms, and fails if any block that was on would go off.

## Why `core.can`

One check where every access decision is already made (rule 2) gives every block the same
"off" without touching its tables, policies or functions, and a block added later gets it by
listing its domains. The cost is one read of the customer's settings per call, by primary key:
measured locally, 20,000 calls take 8.4 to 8.7 s against 7.0 to 7.7 s for the grants alone
(about 0.06 ms a call). RLS calls `core.can` once per place per query (ADR 007), not per row.

## Tests

`blocks.db.test.ts` (the order and needs; every customer kept what it had; nobody in a customer
can switch anything; a platform admin's switch, audited; `NOT_IN_PLAN`; the console's list; a
bundle out and back in; every block's domains refused for everyone who had them and back again;
rows hidden and kept; Leave refused; jobs skipped; pay off gives no labour cost),
`loader-checks.db.test.ts` (the registry equals the database's; file 34 skipped with pay off),
`modules.test.ts`, `bundles.test.ts`, `setup-draft.test.ts`, `form.test.ts`, and the e2e
`blocks.spec.ts` (a platform admin switches a block and a bundle; the cook sees them go; the
owner only looks).
