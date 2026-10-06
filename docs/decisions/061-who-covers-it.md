# 061 — Who covers it (role cover)

Status: accepted · 2026-10-06

Step 4 of `docs/templates-and-cover.md` (ADR 058), on top of the duties (ADR 059) and the
role catalogue (ADR 060).

## Context

Small outlets don't have every role. Guest House 2.0 has no Store Keeper: the Front Desk
receives the deliveries. Until now that meant granting the Front Desk the Store Keeper's
groups by hand (file 08). Nothing tied those grants to the reason for them. The Store
Keeper's checklists also had nobody to go to.

## Decision

1. **Stored per outlet, exceptions only** (`hr.role_cover`).
   - Each row says a role is `covered_by` another role, or `not_done` there.
   - No row means the outlet has the role, so every outlet without a row is exactly as
     before.
   - The table has RLS, read as USER_ACCESS at the outlet, with no writes from the app. It is
     audited and archived, never deleted.
   - It is loaded from the optional file `37_role_cover.csv`, which is authoritative when
     uploaded; a re-import without it leaves covers alone. Admin's
     "Who does what" (Step 6) will write the same rows.
2. **Cover by role (decided 6 Oct).**
   - Everyone in the covering role at that outlet gets the covered role's grants there.
   - `core.derive_job_role_access` adds them, worked out by the same
     `core.derive_job_role_access_at` as a person's own role. Every way access is applied
     (the loader, Admin's user screens, `core.sync_job_role_access`) picks cover up with no
     other change.
   - Where the grants are worked out: the covered role's usual department at that outlet.
     If the outlet doesn't have that department, the covering person's own home is used, so
     cover never reaches past where they already work.
   - Each grant's source reads "covers Store Keeper".
3. **What a cover may not be** (`core.role_cover_errors`, stable codes):
   - a role covering itself (`COVER_SELF`);
   - a chain, where the covering role is itself covered or not done there (`COVER_CHAIN`);
   - a place that isn't an outlet (`COVER_NOT_OUTLET`);
   - duties that don't resolve there (`JOB_ROLE_SCOPE`). Bar 3.0 has no main store, so its
     Store Keeper can't be covered;
   - grants over the area or the company (`COVER_ABOVE_OUTLET`);
   - account administration (`COVER_ADMIN`).
4. **A lower role covering a higher one gets a warning, not a refusal (decided 6 Oct).**
   - The warning comes only when the covered role runs a department or the outlet, and the
     covering role is lower.
   - Leading a shift or keeping a store is covered by staff every day; warning on it would
     be noise.
   - Other dry-run warnings:
     - someone already holds the covered role there;
     - nobody holds the covering role there yet;
     - a checklist loses its rounds.
5. **Covered tasks go to one person (decided 6 Oct).**
   - A job-role task for a covered role is in the covering role's pool at that outlet
     (`ops.in_pool`).
   - The 5-minute tick gives it to one of them when it comes due, 30 minutes ahead with the
     reminder (`ops.give_covered_task`).
   - Who gets it:
     1. People on duty only. Clocked in comes first, then those on a published shift.
     2. The one with the fewest open tasks.
     3. On a tie, whoever was given a covered task longest ago (round robin).
   - With nobody on duty, it stays in the pool and goes to whoever comes on.
   - If the person goes off duty before starting it, it moves to someone on duty.
   - They are notified, and their task list says "Store Keeper's work (you're covering)".
   - A role the outlet has keeps its pool, as before.
6. **Not done stops the checklists only (decided 6 Oct).**
   - The role's checklist rounds are not created at that outlet.
   - Its approvals and alerts already go up the place tree to the department head, then the
     GM, so nothing is dropped silently.

## Consequences

- **Nobody's access changes.**
  - The test customers have no cover rows.
  - A fresh seed gives the same `core.role_assignment` rows as before. The DB tests add
    their own covers inside rolled-back transactions.
- **Approvals, the To do list, the bottom nav and reports follow the grants.** A person
  covering the Store Keeper sees the Main Store's To receive and can receive.
- **A person can lose cover access in three ways:**
  - the cover changes;
  - they leave the covering role;
  - they move outlet.

  Each of these re-applies access, through the loader (`core.apply_cover_access` for every
  person at the outlet) or through Admin's user screens.

- **Not built yet:**
  - "Duties with nobody" per template comes with the templates (Step 3). Until then, the
    loader's dry run warns about the covers it is given.
  - Admin's screen for cover is Step 6.
  - A head moving a covered checklist task by hand needs the same reassign that receive tasks
    have. That is not built for checklists.
