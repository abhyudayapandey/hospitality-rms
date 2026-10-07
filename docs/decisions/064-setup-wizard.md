# 064 — The set-up wizard

Status: accepted · 2026-10-07

Step 5 of `docs/templates-and-cover.md`, on top of the outlet templates (ADR 062) and cover
(ADR 061).

## Context

A sales or onboarding person, not a developer, sets up a new customer. Until now that meant
writing the customer's onboarding files by hand, or creating the company and owner in the
console and then importing files. They must never see a code, a CSV file or a command, and
what they set up must load first time.

## Decision

1. **Seven screens in the platform console** (`/platform/setup/<draft>/<step>`), one after the
   other, each with Back and Next:
   1. **Company:** name, country, currency, time zone, the owner (name and email), and whether it
      is a demo or test company. The short name used in logins is suggested from the name.
   2. **Outlets:** a tile, a name, the extras ticked (the Step 3 screen), an optional area, and an
      optional location and radius for clock-in.
   3. **Departments:** the template's, as ticks. For a café, its own pieces come first, then
      "Also in a restaurant".
   4. **Roles:** for each role the template expects: **We have it**, **Someone else does it:
      [role]**, or **We don't do this**. A plain-words line says what moves ("The Restaurant
      Manager also does the Head Cook's work: runs the department, keeps the department's
      store"). A junior covering a department head or above is flagged.
   5. **People:** typed rows, or pasted from a sheet (name, email, role, outlet). A role is matched
      by its title or another name the SOPs use; a near miss says "did you mean Cook?".
   6. **Stock:** each store's starter items, kept or left out, with a par. They can add their own
      items (name, unit, par).
   7. **Who does what:** every role at every outlet, what it does, and who does it (a person, a
      role covering, "Not done here", or "Nobody added yet"). Then **Go live**.
2. **Saved at every Next** as a draft (`platform.setup_draft`; platform admins only, every change
   in the platform audit). The console home lists "Set-ups in progress", and a draft opens on
   the screen where it was left.
3. **Nothing is created until Go live, which takes two taps.**
   - **Check everything** creates the customer (the usual create job), then dry runs the files
     made from the draft. The report is shown in plain words, and each problem links to the
     screen that fixes it.
   - **Looks right: apply and send logins** applies the same files, then invites the owner and
     everyone with an email.
   - Saving the draft after a check clears that check, so what is applied is always what was
     last checked. Once applied, the draft can't change; later changes are imports (and Step 6).
4. **The wizard holds no rules of its own.** `filesFromDraft` (`packages/onboarding/src/setup-draft.ts`,
   pure) writes the customer's complete files: `customerBundle`, then `addOutlet` per outlet,
   then file 04 (locations), 37 (cover), 07 (people) and 10/11 (items and par). The loader
   checks them like any import. Codes are made from names: the customer's short name, then
   `<SHORT>-<OUTLET NAME>`, and login IDs `<short>.<first>.<last>`, numbered when two are alike.
5. **Logins (decided 6 Oct).** Everyone sets their own password at their first sign-in.
   - A person with an email gets an email invitation.
   - A person without one gets a login ID and a one-time password. After Go live, the console
     creates them and **prints a login sheet** for the manager: name, login ID and password. The
     sheet is made in the browser, and the passwords are never stored. The Logins page offers
     the same sheet.
   - Phone OTP is not built; it would be its own step (SMS set-up and cost).
6. **All platform admins** can use the wizard (decided 6 Oct). A restricted onboarding admin
   can come later.

## Consequences

- **A customer from nothing, without a file.** The test (`setup-draft.db.test.ts`) sets up a
  customer for every kind of outlet with everything it offers: a person in each role, one role
  covered by the manager and one not done, par on the stock. Each loads with no issues, a second
  load changes nothing, everyone has access, and the covering manager holds what the covered
  head would hold there.
- **The e2e walk** (`e2e/setup-wizard.spec.ts`, 380 px) sets up a café company, leaves it half
  way and resumes it, covers one role and drops another, types and pastes people, sets a par,
  goes live in two taps and prints the login sheet.
- **Not in this step:**
  - "Add an outlet" for an existing customer stays its own page (ADR 062); the wizard is for new
    customers.
  - Admin → Who does what after go-live (Step 6).
  - The wizard in the customer's own Admin.
- **A demo abandoned after "Check everything"** leaves a customer created (empty but for the
  owner, not invited). Mark demos as test companies; a test customer can be suspended.
