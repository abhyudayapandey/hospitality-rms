# 060 — The role and department catalogue

Status: accepted · 2026-10-06 (no migration)

Step 2 of `docs/templates-and-cover.md` (ADR 058), on top of the duties (ADR 059).

## Context

Each customer's file 06 spelled out every job role from nothing: its code, title,
department and access. The six SOP manuals in `docs/sop/` name about a hundred jobs. Most
are the same in every customer, and later steps need them in one place:

- the templates (Step 3);
- "who covers it" (Step 4), which needs each role's level;
- the set-up wizard (Step 5).

## Decision

1. **One catalogue, product code** (`packages/domain/src/catalogue.ts`).
   - 22 departments, each with a type (ADR 033) and the store it usually keeps.
   - 101 roles, each with a title, other names, where it works, its default duties, any
     per-format duties, and the SOPs that name it.
   - Reference files: `docs/onboarding/test-data/PRODUCT_roles_REFERENCE.csv` and
     `PRODUCT_departments_REFERENCE.csv`. A test keeps them in step with the code.
2. **Roles follow the SOPs (decided 6 Oct).**
   - Every role an SOP names is its own role. Two names are one role only where the SOP
     itself lists them as one job, like "Steward / Server".
   - Codes that already mean something else keep their meaning:
     - The QSR's Store Manager is `QSR_STORE_MANAGER`, titled "Store Manager". A hotel's
       `STORE_MANAGER` heads the Stores team.
     - The standalone restaurant's Restaurant Manager is `RESTAURANT_GENERAL_MANAGER`,
       titled "Restaurant Manager". A hotel's `RESTAURANT_MANAGER` heads a department.
   - Two roles may share a title only when they work in different places.
3. **A role only holds duties for work the app does today.**
   - A Night Auditor, a Therapist or a Revenue Manager "works shifts": rostered, clocking
     in, given checklists and tasks. They hold no duty for their specialist work.
   - The Duty Manager leads the shift at the outlet; outlet-wide approvals wait for a duty
     that applies only during duty hours.
   - The Food Safety Supervisor leads the shift until Step 4 brings a food-safety duty.
   - Head-office and franchise roles are left out until they have company-wide duties.
4. **A role's level is worked out from its duties, never set by hand** (`levelOf`).
   - The levels are: above the outlet, runs the outlet, runs a department, leads a shift
     (keeping a store counts), does the work.
   - So a level can never disagree with what the role may do.
5. **File 06 can name a catalogue role by its code alone.**
   - A blank `job_title`, `usual_department` or access comes from the catalogue.
   - A blank `any` row also brings the catalogue's rows for other outlet formats, such as
     the Bar Manager running a standalone bar, unless the file lists that format itself.
   - A row that is filled in is used as written.
   - A role not in the catalogue must still be filled in; the loader says so, by file,
     row and column.

## Consequences

- **No one's access changes, and the test customers' files are unchanged.**
  - They differ from the catalogue in two places only, pinned by a test: the Host works in
    two departments, and the solo bar's Head Bartender keeps the bar store.
  - Loading Test Company with every role that matches the catalogue listed by code alone
    (about 50) gives the same access and the same job roles.
- **Nothing changes on screen.** Admin's job roles are still the customer's own.
- **The catalogue doesn't create departments.**
  - Making departments, and their type, from it is Step 3, for new places only.
  - Setting the type of an existing department would change Home's order for a customer
    who loaded it blank.
- **New SOP roles.** When an SOP role gains real work in the app, it gains the duty in the
  catalogue. Customers who list it by code alone get it on their next import.
