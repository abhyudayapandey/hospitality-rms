# 065 — Admin → Who does what (changing cover after go-live)

Status: accepted · 2026-10-07 · migration 20261120100000

Step 6 of `docs/templates-and-cover.md`, on top of who covers it (ADR 061). File 37 sets
covers at onboarding; after go-live the customer changes them themselves. The common cases:
"Our Sous Chef left; the Executive Chef covers" and "We hired a Store Keeper; stop the GM
covering".

## Decision

1. **Who.** An Account Owner, or a user admin for the outlets in their user administration
   (`USER_ACCESS` modify there). Department heads can't: cover changes people's access, and
   access belongs to user administration. A user admin with view access only sees the list.

2. **Where.** Admin → Who does what (`/admin/cover`). The Place picker has "All outlets"
   first (ADR 038). That view is read-only: it lists only the covers in place, across the
   outlets the admin may see. Choosing an outlet lists every role that works there: its
   department is there or it works at outlet level, it has access for the outlet's format,
   it doesn't work above the outlet, or someone there holds it or it has a cover. Roles are
   listed highest level first. Each role shows "We have it · 2 people" (or "nobody here
   yet"), "Someone else does it: [role]" or "We don't do this". A role opens its own page:
   - the three answers, and a role picker for "Someone else does it";
   - the plain-words line saying what moves, from the covered role's duty names;
   - the same warnings as file 37's dry run;
   - whose access changes and where the open tasks go;
   - then Save.

3. **The same rules and checks as file 37.** `core.set_role_cover` refuses whatever
   `core.role_cover_errors` refuses, with the same code. The warnings (a junior covering a
   department head or above, nobody in the covering role, people still in the covered
   role) are one pure function, `coverWarnings` (`packages/domain/src/cover.ts`), used by
   the loader and by Admin. Each passes in its own counts. "We have it" with nobody in the
   role also says so.

4. **Checks, first.** `core.set_role_cover` and `core.preview_role_cover` are security
   definer with a pinned `search_path`. Before anything else they check that the outlet is
   one of the caller's own company's outlets (`NOT_FOUND`, the same answer as for an outlet
   that doesn't exist), then user administration, then that the outlet is in scope. So
   neither can be used to look at another customer's places.

5. **Access, at once, through the usual guardrails.** After the cover row is saved,
   `core.sync_job_role_access` runs for every active person at the outlet, in the same
   transaction. So the existing rules hold:
   - **Your own access.** A change that would alter the admin's own access is refused with
     today's `SELF_GRANT` wording ("ask another administrator"). That includes "We have it"
     when it stops the admin covering.
   - **Rank.** Changing the access of someone above your rank is refused.
   - **Sensitive grants.** These (for example `OUTLET_HR`, when the GM covers the HR
     Executive) become role-change requests waiting for approval. The cover is saved but
     that access isn't live yet, and Save says so ("Saved. 2 access changes are waiting for
     approval").

   One failure rolls back the whole change. The preview runs the save and rolls it back
   (as `core.preview_create_user` does), so it can't drift from Save.

6. **Open tasks of the moved duty.** Only the covered role's open, unstarted (`open`)
   job-role tasks at that outlet move:
   - A person who is no longer in the role's pool (the old coverer) loses their unstarted
     tasks back to the role's pool.
   - **Someone else does it.** What is due within 30 minutes goes at once to a coverer on
     duty (`ops.give_covered_task`, as the 5-minute tick would). The rest waits for the
     tick.
   - **We have it.** The role's own people take the tasks from the pool.
   - **We don't do this.** Nothing is cancelled: unstarted tasks stay unassigned, and the
     preview counts them ("3 open tasks stay unassigned"). Escalation handles them when
     they are overdue. New rounds stop, as for file 37.
   - A task someone has started stays with them, always.

7. **Audit.** `hr.role_cover` is audited, so each change carries its author. The access it
   gives or ends is in the access audit, with the source "covers X". The row also records
   `set_in_app_by` / `set_in_app_at`, and the page shows "Changed by …".

8. **File 37 and the console.** The files are the whole truth, so an import's file 37 can
   undo an Admin change. Two things guard against that:
   - **The dry run warns.** It warns when file 37 would change or remove a cover set in
     Admin since the last import, naming who set it and when (as for locations, ADR 018).
     Writing the row clears the mark.
   - **Add an outlet keeps Admin's covers.** The console's "Add an outlet" builds on
     `currentFiles`. That now writes file 37 from the live covers
     (`platform.role_cover_rows`, platform admins only), so adding an outlet keeps what
     Admin set.

   The set-up wizard (ADR 064) writes a new customer's files from its own draft, so this
   doesn't touch it.

## Consequences

- **Re-syncing applies older drift.** Saving re-syncs everyone at the outlet. A person whose
  job-role access had drifted for another reason is brought in line too, as an edit in
  Admin → People would.
- **The preview's notifications are rolled back.** A covered task the preview would hand
  out sends no notification, because the preview's transaction is rolled back.
- **Admin can't see every file 37 error.** `COVER_NOT_OUTLET` can't be reached from Admin:
  a department isn't offered, and the function answers `NOT_FOUND` for it.
