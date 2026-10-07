# 069 — Compliance: a licence register, a compliance calendar, and "What they buy"

Status: accepted · 2026-10-07 · migration 20261124100000

The SOPs keep two things on paper that the app did not (`docs/templates-and-cover.md`
section 7): the outlet's licences with their expiry dates, and the jobs the law or the
insurer wants done every few months (pest control, duct cleaning, fire drills, water tests).
A licence that lapses closes the outlet; a job not done fails the next inspection.

## Decision

1. **Compliance is its own bundle, out of the plan unless the platform admin adds it.**
   `BUNDLES` gains Compliance with `outByDefault`; `core.bundle_default(bundle)` is false for
   it alone, so a customer whose settings don't name it (every existing one) doesn't have it.
   Only the platform admin puts it in the plan (`platform.set_bundle`, ADR 067). Its one
   module is `compliance`; file 00 may say `compliance: yes|no` inside the plan.
2. **One domain, `COMPLIANCE`, on the org tree, an admin domain** (company legal records), so
   the Account Owner sees it with the admin groups. The outlet manager keeps it (modify), the
   area manager and the Account Owner see it. A job role gets it with the new duty
   **Keeps the licences and compliance calendar** (`KEEPS_COMPLIANCE` →
   `COMPLIANCE_KEEPER@whole_outlet`). People only see it for the outlets they may.
3. **The licence register** (`ops.licence`): what it is (from the product's licence kinds,
   FSSAI to the swimming pool licence, or another), number, issued by, issued and expiry
   dates, the documents, and **who renews it: a job role, the General Manager by default**,
   changeable per licence. A renewal is a new licence row; the old one is kept with
   `replaced_by`, so the history reads back. A renewal needs the renewed licence
   (`DOCUMENT_NEEDED`) and a later expiry. A licence no longer needed is archived with a
   reason, never deleted.
4. **The compliance calendar** (`ops.compliance_item`, `ops.compliance_done`): a job, its
   place (the outlet or one of its departments), how often (1 to 36 months), when it is next
   due, whose job it is, and whether each time needs a report or certificate. Marking it
   done records the day, the documents and a note, and moves the next due date on by its
   months from the day it was done. **Calendar jobs are their own list, not checklists**: a
   checklist is a round of steps on a shift; a calendar job is one thing every few months.
5. **Reminders are To do items** (`ops.task` kinds `licence` and `compliance`), made by
   `ops.compliance_tick`, which the tasks job runs every 5 minutes (ADR 020): a licence's
   renewal 90 days before it expires, for its renewal role, with notices again at 30 and 7
   days, due on the expiry day; a calendar job 14 days before it is due, for its owner role.
   When it is late the usual task reminders and escalation (ADR 020) take it up the line. Whoever a reminder is
   with may renew or mark done from the To do item, without the keeper's access; the item
   closes when it is done.
6. **Documents** are photos or PDFs under `compliance/<tenant>/<outlet>/` in the photo bucket,
   up to 5 each, 10 MB like bills. **They never expire**: no lifecycle rule touches the
   prefix. The instance role gains put and get on `compliance/*` (a stack change).
7. **Home** names what is late: "N compliance jobs overdue" (Open) and "N licences expiring"
   (Renew, 90 days or expired), each opening Compliance on its tab with All outlets chosen
   (ADR 038, 048). Compliance is one screen with four tabs: Licences, Calendar, Expiring,
   Overdue; each tab's count is its list, counted in SQL (ADR 052). The two lines take their turn among
   Home's five (low stock, late tasks and open shifts come first); a late renewal or job is
   also a late task.
8. **The set-up wizard asks "What they buy"** right after Outlets. Every bundle is listed: the
   ones the chosen outlets usually need are ticked, the rest unticked under "Also available".
   Compliance is offered, never ticked by itself. With it, the wizard writes files 38
   (licences) and 39 (calendar) from the product library for each outlet's format and
   extras: the manager renews; a kitchen job goes to the kitchen head and an engineering job
   to the chief engineer, or to whoever covers that role (ADR 061), else the manager.
   Without Tasks & food safety, the starter checklists (file 29) are left out. **Bundles are
   what is bought; departments and extras (pool, spa, gym, ADR 068) are what is there.**
   Ticking a hotel's pool doesn't buy anything; it adds the pool's people and checks.

## Consequences

- New onboarding files: `38_licences.csv` and `39_compliance_calendar.csv` (any customer),
  keyed by place and name, so a re-import updates rather than adds. A role with nobody in it
  at the outlet is a warning: its reminders would reach nobody.
- Test Company has Compliance in its plan (`seed/dev/002_compliance_plan.sql`; on the cloud
  the platform admin turns it on), three licences (Hotel 1.0's FSSAI expired) and three
  calendar jobs (Hotel 1.0's pest control overdue). Test Solo Bar Co. hasn't bought it.
- `pnpm db:seed` runs the tasks job once, so the FSSAI renewal and the pest control service
  are on the General Manager's To do list after a seed.
