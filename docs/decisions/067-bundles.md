# 067 — Selling by bundle

Status: accepted · 2026-10-07 · migration 20261121100000

Step 8 of `docs/templates-and-cover.md`. A customer buys bundles, not modules. Bundles sit
over the module switches of ADR 026, which stay as they are.

## Decision

1. **Three bundles, over the eight switches only.** `packages/domain/src/bundles.ts`:

   | Bundle              | Its modules                            | Always included with it       |
   | ------------------- | -------------------------------------- | ----------------------------- |
   | Stock & cost        | Production, Prep lists, Menu and sales | stock, orders, bills, recipes |
   | People & roster     | Leave, Shift swaps, Events             | the roster, clock-in          |
   | Tasks & food safety | Checklists, Maintenance                | tasks                         |

   Stock, orders, bills, recipes, the roster, clock-in, tasks and reports have no switch
   (ADR 026) and come with every plan. So the plan's fourth bundle, Reports, would have had
   nothing to switch; reports are always included. A report only shows what the bundles on
   bring (Menu and sales off: no sales figures, as before).

   Every module is in exactly one bundle, and a module a module needs is in the same bundle
   (Prep lists needs Production, so both are in Stock & cost). No bundle depends on another.
   A unit test checks both, and a DB test keeps the codes equal to `core.bundle_codes()` and
   `core.module_bundle()`.

2. **The plan is the only new state.** It is stored in `core.tenant.settings` under
   `bundles`, beside `modules`: `{"tasks_food_safety": false}`. A bundle that isn't listed
   is in the plan. A module is on when its bundle is in the plan and the company hasn't
   turned it off (`core.module_on`). So every screen, the tasks job and the workflow trigger
   follow the plan with no change of their own.

   "On / Partly on / Off" is never stored. It is worked out from the modules (`bundleState`).
   The plan has to be stored, because that is what the refusal needs: a bundle the customer
   bought, with every module turned off, is still theirs to turn back on.

3. **Existing customers keep everything.** The migration writes nothing. No customer has
   `bundles` yet, so every bundle is in every plan, and every module that is on today stays
   on. Both test customers have every bundle.

4. **Only the platform admin changes the plan.** The plan is what is sold.
   - **The console's customer page** has a Bundles card. Each bundle shows its state and the
     modules the customer turned off, with a switch. Turning one off asks first.
   - **`platform.set_bundle(tenant, bundle, on)`** checks the platform admin and writes
     `bundle_on` / `bundle_off` to the platform audit. Turning a bundle on turns its modules
     on, since that is what was sold. Turning it off keeps the modules' own switches, but
     they are off while the bundle is out.
   - **`platform.customer_modules(tenant)`** feeds the card. It is for platform admins only;
     customers get `NOT_AUTHORISED`.
   - **The owner can't go around it.** `core.set_company_settings` refuses any key it
     doesn't know, `bundles` included.

5. **The Account Owner works inside the plan.**
   - **Admin → Modules** lists the modules under their bundles. Each bundle shows "On" or
     "Not in your plan", read-only.
   - **Inside a bundle that is on**, the owner still turns single modules off and on
     (`core.set_module`, as before).
   - **`core.set_module` refuses** turning on a module whose bundle isn't in the plan, with
     `NOT_IN_PLAN` ("Not in your plan. Ask Outlet Ops to add it."). Turning one off is always
     allowed.

6. **A template never switches a module on.** `addOutlet` used to set file 00's module
   columns to yes for what the outlet's template needs, which let the template decide what a
   customer has. Now it changes nothing in file 00, and two places say what is missing:
   - **The console's Add an outlet review** says it in words: "This outlet uses Checklists,
     part of Tasks & food safety, which isn't on for this customer".
   - **The loader's dry run** warns the same for every outlet new to the import (file 01,
     `outlet_format`), from its format's template.

   File 00's module columns still set the switches. A platform admin's import can't put a
   bundle in the plan, though: a module set on in a bundle out of the plan stays off.

7. **The set-up wizard** (ADR 064). The review step lists the bundles the draft's outlets use,
   ticked by default. The platform admin may untick one ("What they buy"; the draft's
   `bundlesOff`). Go live puts the ticked ones in the plan and leaves the rest out, through
   `platform.set_bundle`, so it is audited like the card. That happens before each check and
   again before the apply, so ticks changed after a check are what goes live. Without this, a
   wizard customer would go live with checklists loaded but switched off, or switched on
   without being bought.

## Consequences

- **A bundle back in the plan undoes the owner's own offs in it.** Turning a bundle back on
  turns all its modules on, including one the owner had turned off before it was taken out.
  The owner turns it off again if they want.
- **File 00 and the plan can disagree.** A file 00 that sets a module on in a bundle out of
  the plan loads without an error, and the module stays off. The dry run's note is about new
  outlets only, so outlets already loaded say nothing on every re-import.
- **Pricing is not here.** Nothing about price is stored.
