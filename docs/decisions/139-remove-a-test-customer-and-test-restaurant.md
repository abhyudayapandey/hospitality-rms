# 139. Remove a test customer; [TEST] Restaurant

Date: 2026-10-13. Status: accepted. Migration `20261226100000_remove_test_customer`.

## Context

The product needs a dry run on a restaurant with a bar, made the way a real one would be: the
set-up wizard's "Restaurant + Bar" outlet with one person per job role. Live has four test
customers. Two of them, Test Company and Test Solo Bar Co., are the CI test data and are not
demos. The console can empty a test customer (Start again, ADR 130), but it stays on the list
and its code can't be used again, so there is no way to retire a test customer we no longer
want.

## Decision

1. **[TEST] Restaurant** (`docs/onboarding/demo/test-restaurant`) is written by
   `pnpm --filter @outlet-ops/onboarding restaurant-demo`. The script fills the wizard's draft
   (`emptyDraft`, `roleQuestions`, one person per role, the bar ticked) and writes its files
   with `filesFromDraft`, the wizard's own code. It then adds what the wizard leaves to the
   customer: usernames and a demo presenter instead of emails, suppliers, items, a menu with
   recipes, sections, and the past week's test data (files 25 to 35). A change to the wizard's
   template shows up in this demo the next time it is written.
   `restaurant-demo.db.test.ts` loads it as the console does (platform loader, the plan from
   the README) and checks no problems, no warnings, a second dry run with no changes, one
   person per role, and the week behind it.
2. **Remove a test customer** (`platform.remove_test_customer(tenant, confirm)`, the console's
   customer page, behind its own fold under Start again). It first does what Start again does
   (the same checks: a platform admin, a test customer, its name typed), then marks the
   customer `removed_at`. A removed customer:
   - is not in the console's list (`platform.customers()`);
   - is not active (`core.tenant_active`), so nobody can sign in to it;
   - can't be paused, resumed, started again or un-removed (`CUSTOMER_REMOVED`, a trigger on
     `core.tenant`); its settings may still change, so migrations that update every
     customer keep working.

   The customer's row stays, with the console's own records (jobs, files, audit). Its code is
   not used again. A real customer can never be removed (`REAL_CUSTOMER`).

## Consequences

- Test Company and Test Solo Bar Co. can be removed from live from the console. They stay in
  the repository as CI test data until the tests move to Passport and [TEST] Restaurant.
- The readiness dry run found six gaps for a restaurant with a bar (Push today shows food to
  bar staff; nobody can be given a repair; no starter SOPs; no checklist of their own for the
  sous chef and assistant manager; the cashier only imports the till file; the GM approves
  every stock count). They are open items, not part of this decision.
