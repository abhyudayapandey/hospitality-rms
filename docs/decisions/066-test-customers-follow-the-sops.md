# 066 — The test customers follow the SOPs

Status: accepted · 2026-10-07

Step 7 of `docs/templates-and-cover.md`, after the templates (ADR 062), cover (ADR 061) and
the wizard (ADR 064).

## Context

The test customers were written to the original plan, before the SOP manuals were the
reference. Compared with the templates they were close, but some of their people held roles
the SOPs don't name, under other names, and no test customer had a cover or a library
checklist. The rule (decided 7 Oct): the SOPs come first and the test data follows them. A role
that is an SOP role under another name takes the SOP's name; a role the SOPs leave out is kept
only when it is a real job, and then the template gains it. Nothing is duplicated because its
name differs.

## Decision

1. **Roles, checked one by one against the SOPs' role tables:**

   | Test data had                           | The SOP has                                                                       | Done                                                                                                                                   |
   | --------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
   | Guest Relations Executive               | Guest Service Associate (hotel front office): our Front Desk Executive            | the two people are Front Desk Executives                                                                                               |
   | Host (hotels)                           | Captain / Supervisor and Steward / Server; no host in a hotel restaurant          | the two people are Stewards (same access)                                                                                              |
   | Store Manager (hotels)                  | Purchase Manager, head of Purchase and Stores                                     | the two people are Purchase Managers; "Store Manager" is another name for it, which now runs the department; the hotel template has it |
   | Stock Verifier (Solo Bar)               | Accountant / Excise Clerk, who does the monthly count with the GM (bar SOP LC-07) | the person is the Accountant, who verifies stock checks in a bar; the Stock Verifier role is gone (the access group stays)             |
   | Bar Back (hotel bars)                   | Bar Back (bar SOP); the hotel SOP's bar lists only Bar Manager and Bartender      | kept; the "Has a bar" extra gains it                                                                                                   |
   | Cook (Guest House 2.0)                  | none fits: the full-service hotel SOP has no single cook for a small hotel        | kept; the hotel template gains it                                                                                                      |
   | Security Guard (Bar 3.0)                | Security / Bouncers                                                               | already in the Bar / Pub template; no change                                                                                           |
   | Central Kitchen Commis, Delivery Driver | the QSR SOP names only the Central Kitchen Manager                                | kept; the central kitchen extra gains them                                                                                             |

   Everyone keeps exactly the access they had; seven test people have new login names
   (`test.solo.accountant`, `test.purchase-manager.1.0`, ...).

2. **One cover each** (file 37): Guest House 2.0 has no Store Keeper and its Front Desk
   Executive covers it; the Solo Bar's Kitchen Steward is not done. The only access change in
   `99_access_preview_GENERATED.csv` is the Front Desk's STORE_KEEPER at 2.0's supply point,
   source "covers Store Keeper".
3. **A grant someone holds through their own role stays their own** when a role they cover
   gives it too (migration `20261122100000`). The first cover in the test data showed the
   source of such a grant (STAFF at 2.0) flipping between loads.
4. **Library checklists in the test data:** Hotel 1.1's kitchen gets Kitchen opening and the
   Chiller and freezer log as library copies (`from_library` `@1`).
5. **A test pins the test customers to their templates** (`test-customers-templates.test.ts`):
   every department of a test outlet is one its template has, every role its people hold is one
   its template or its extras expect, every library copy names a library checklist. Allowed:
   Guest House 2.0 has no departments (everyone works at the outlet; decided 7 Oct to keep it).
6. **The set-up wizard's check speaks in names** (ADR 064, found testing it on 7 Oct): Go live
   shows the dry run's warnings with each code replaced by its name (places, roles, people,
   access groups, from the draft's own files), leaves out advice about a file's syntax, says
   each once, and says they don't stop going live. An outlet named like its company is
   `<company>-MAIN`, not `TEST-CAFE-TEST-CAFE`. An upload holds up to 50 files (Test Company
   now has 41).
7. **Access ended in Admin comes back when it is given again** (migration `20261122110000`).
   Admin → Who does what ends a grant rather than deleting it (ADR 065); an import or a cover
   saved again then re-applied access through `core.apply_job_role_access`, which saw the
   ended row and gave nothing. Only live rows count now, and an ended job-role row for the
   same group and place is replaced, as Admin's own sync does. Found when the seed's cover was
   switched off and on again in the same day.

## Consequences

- The reports reconcile test includes a covering person; the role-cover tests start from the
  seed's covers; the e2e cover helper restores the seed's cover after each spec.
- Production: both test customers are re-imported. An import never removes a person, so the
  seven old test logins are deactivated in Admin → People by the Account Owner, and the seven
  new ones get logins on the console's Logins page (`docs/deploy.md`).
- ADR 043's Stock Verifier is now the bar's Accountant; its STOCK_VERIFIER access group is
  unchanged.
