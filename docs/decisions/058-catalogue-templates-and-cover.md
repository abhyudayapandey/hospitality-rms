# 058 — One catalogue, outlet templates and "who covers it"

Status: accepted · 2026-10-06 (direction) · built 2026-10-07: Steps 1 to 8 and the final pass (ADRs 059 to 068 and 070)

The plan is `docs/templates-and-cover.md`; the SOP manuals and the comparison it comes from
are in `docs/sop/`. This ADR records the decisions it rests on.

## Context

- **Six business types.** We compared six SOP manuals: restaurant, bar and microbrewery,
  cloud kitchen, franchise, hotel and resort, and QSR. Most of their roles and work overlap:
  - a bar is a restaurant plus alcohol;
  - a cloud kitchen is a restaurant kitchen plus delivery;
  - a QSR is a restaurant plus a chain and a central kitchen;
  - a hotel is a restaurant plus rooms and more departments;
  - franchising is an ownership layer over any of them.
- **Real outlets differ from the manuals.** They lack roles, and someone else does that
  work: no Sous Chef, so the Head Chef orders; no Store Keeper, so the GM receives.
- **Onboarding is slow.** It is 36 CSV files today. Job roles hold `GROUP@scope` defaults
  (ADR 009). Moving one piece of work from a missing role to another person means editing
  grants, checklist assignments and alerts separately.

## Decision

1. **One catalogue, owned by the product.** Duties, roles, departments, a checklist library
   and starter items are product code. They are synced to every customer like the access
   groups (ADR 009).
2. **A duty is the unit of responsibility.** It bundles three things:
   - the grants it needs, each a group at a scope word;
   - the tasks and checklists it owns;
   - the alerts it receives.

   Job roles hold duties; the duties resolve to grants. Access groups and `core.can` don't
   change: duties sit on top of them.

3. **Templates are presets, not packages.**
   - Five outlet templates: Restaurant / Café, Bar / Pub, QSR, Cloud kitchen and Hotel
     (full or small).
   - Add-ons: Central kitchen, Delivery and Microbrewery, with Franchise later.
   - A template only selects from the catalogue. Templates are chosen per outlet, so one
     company can mix them.
   - `outlet_format` takes the template codes: `full_hotel` and `small_hotel` become Hotel,
     `standalone_bar` becomes Bar / Pub.
4. **Cover.** For every role in its template, an outlet records one of three answers:
   - `have`;
   - `covered_by <role>`: that role's people take the duties at that outlet only, on their
     own shifts, with no change to rostering;
   - `not_done`: the duty's checklists are off.
5. **Nothing goes unowned.** A duty nobody holds at a place falls to the next level up
   (department head, then GM), as approvals already do. Admin lists any duty with nobody.
6. **The CSV loader stays the engine.** The set-up wizard produces the same files and runs
   the same dry run and apply, so every existing check still holds. Big customers can still
   send files.
7. **Selling is by module bundle**: Stock & cost, People & roster, Tasks & food safety,
   Reports. A template never sets the price; a bundle never sets the structure.

## Consequences

- **No access changes for anyone today.**
  - The duty refactor must leave every test user's derived access exactly as it is. The
    RLS equivalence check (all users) and the access preview file prove it.
  - Cover adds access only at the covering outlet. An RLS test proves it never leaks to
    another outlet.
- **A role change is one answer.** "Our Sous Chef left" is a single cover answer, audited,
  instead of a set of grant and checklist edits.
- **New roles come with the catalogue.** QSR crew, cloud-kitchen and hotel support roles
  arrive with duties for what the app does today. Roles for work the app does not do (PMS,
  POS, excise) get those duties when the features exist.
- **Not covered here.** Franchise, head-office roles across outlets, and rostering one
  person in two jobs are separate decisions.

## Rejected

- **Six fixed packages, chosen per customer.** They break on the first mixed business, and
  they still need a way to handle a missing role.
- **A free pool with no templates.** Flexible but slow: every customer would build their
  structure from nothing.
- **Mapping a missing role by giving the covering people the absent job role.** It would
  roster and report them under the wrong job.
