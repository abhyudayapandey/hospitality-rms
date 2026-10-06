# 059 — Duties: job roles hold duties, not raw grants

Status: accepted · 2026-10-06 (migration 20261113100000)

Step 1 of `docs/templates-and-cover.md` (ADR 058). A job role's default access was a list of
`GROUP@scope` pairs in file 06, such as `DEPARTMENT_HEAD@home_department;
STORE_KEEPER@department_store`. That says how access is granted, not what the person is
responsible for, so no single piece of work can be moved from one role to another. Covering
a missing role (Step 4) needs that.

## Decision

1. **A duty is one piece of responsibility, in plain words, over the grants it stands for.**
   - Examples: "Runs the outlet" is `OUTLET_MANAGER@whole_outlet` +
     `OUTLET_MANAGER@outlet_stores`; "Keeps the Main Store" is `STORE_KEEPER@main_store`.
   - There are 24 duties. They are product code in `packages/domain/src/duties.ts`, beside
     the access groups.
   - A duty is exactly as fine as today's group-and-scope pairs. Splitting a group into finer
     duties would change access, so it is a later, separate decision.
2. **The catalogue reaches every customer like the access groups.**
   - The product sync writes `hr.duty` and `hr.duty_grant` into each tenant, on every
     deploy, seed and load. It is authoritative: a duty not in the code is removed.
   - A duty that a job role still holds cannot be removed: the foreign key fails the sync.
   - Both tables are catalogue: the people who can see user administration can read them,
     and only the sync writes them.
3. **Job roles hold duties.**
   - File 06 has `default_duties`, for example `RUNS_DEPARTMENT; KEEPS_DEPARTMENT_STORE`.
   - The F&B Manager's `RUNS_DEPARTMENT@department:BAR` gives a duty at another department
     of the outlet. Only duties marked for it, today just `RUNS_DEPARTMENT`, can be given
     this way.
   - `default_access` (`GROUP@scope`) still works, for files already sent and for a
     company's own groups (ADR 027). A role may use both columns.
   - The loader refuses:
     - an unknown duty;
     - a duty given at a department it can't be given at;
     - a grant given twice;
     - a role with neither column filled in.
4. **The derivation is unchanged.**
   - The loader expands duties into the same `hr.job_role_access` rows as before.
   - Each row records the duty it comes from in `duty_code`. A direct grant has none.
   - `core.derive_job_role_access_at` reads those rows exactly as it did, so no one's
     access can change through it.
5. **Rows already loaded are labelled, not rewritten.**
   - `hr.label_job_role_duties(tenant)` gives a row its duty when every grant of that duty
     is there for the role and outlet format. It runs after every sync and every load.
   - It touches only unlabelled rows, and only their `duty_code`. A direct grant that matches
     a duty is labelled too, so a file in the old form re-imports with no changes.
   - It runs for the product sync and the loader only, never the app.

## Proof that no access changed

- Both test customers were seeded on master and on this change. Every person's grants
  matched exactly: 218 grants, with their places, "this store only", source notes and
  dates.
- Running this migration and the deploy's sync over the master-seeded database labelled
  all 109 job-role rows and changed no grant.
- Tests that keep it so:
  - `99_access_preview_GENERATED.csv` is unchanged, and the loader test still compares
    every person against it.
  - `duties.db.test.ts` (workflow): the catalogue is in every tenant; the sync restores it;
    clearing and re-labelling leaves every person's derived access the same; partial duties
    and a company's own groups stay unlabelled.
  - `duties-loader.db.test.ts`: duties and the same grants spelled out load to the same
    rows and access, and the old form re-imports with no changes.
  - `duties.db.test.ts` (db): only user admins read the catalogue, and the app cannot write
    it or run the labelling.

## Consequences

- Nothing changes on screen. Admin still shows job roles by their access.
- Step 4 (cover) gives a covering role's people another role's duties at one outlet; with
  this in place it adds duty rows, not hand-picked grants.
- A new access group or scope that a job role needs should come with a duty. Otherwise it
  stays a direct grant until it has one.
