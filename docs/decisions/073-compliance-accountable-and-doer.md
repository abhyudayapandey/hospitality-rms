# 073 — Compliance: who answers for a regular job and who does it; Needs action first

Status: accepted · 2026-10-07 · migration 20261129100000 · who sees a handed-on task: ADR 074

ADR 069 gave each calendar job one role, "whose job it is": that role got the To do item 14
days before it was due and marked it done. In a hotel the General Manager answers for pest
control but doesn't do it: the executive housekeeper or the chief engineer books the vendor,
is there on the day and files the certificate. The GM couldn't hand the reminder to anyone
either: only a delivery to receive could be handed on (ADR 051). And the Compliance screen's
four tabs mixed two splits, kind (Licences, Calendar) and status (Expiring, Overdue), so a
GM didn't know where to look, and "Calendar" didn't say what was in it.

## Decision

1. **Two roles per regular job.** `owner_role` **answers for it**: it is checked at the
   job's outlet (a GM answers for a kitchen job too), it is told when the job comes due and
   when it is done (`compliance_due`, `compliance_done` notices to its people at the outlet,
   `ops.accountable_people`), and it keeps the job on Home's Compliance card as before.
   The new optional `doer_role` **does it**: it is checked at the job's place, gets the To do
   item (`ops.compliance_tick`) and marks it done. None means the accountable role does it,
   as before; the same role as the accountable one is stored as none. An open reminder
   follows a change of who does it, in the app (`ops.save_compliance_item`) and on a
   re-import (the loader moves job-role reminders to the job's doer).
2. **Handing on.** Whoever has a licence renewal or a regular job's To do item, or keeps
   Compliance at its place, may give it to one person who works there
   (`ops.reassign_task`, `ops.hand_on_people`), who then renews or marks it done. A delivery
   to receive is still handed on only by its department head. `ops.may_hand_on` never
   returns null (`ops.can_work` is null for someone outside an unassigned task's pool).
3. **The screen's tabs** are **Needs action** (licences within 90 days and jobs within 14,
   red first: the rows of Home's card, which now opens it), **Licences** and **Regular
   jobs**, each counted in SQL (`ops.compliance_counts.needs_action`). Each row carries its
   status chip (valid, expires in N days, expired; due in N days, overdue), so Expiring and
   Overdue are no longer tabs. A job row says who does it and who answers for it.
   "Calendar" is now "Regular jobs" in the words; the screens' paths stay.
4. **File 39** takes an optional `doer_role`. The set-up wizard (ADR 064) makes the outlet's
   manager accountable for every job and its kitchen head or chief engineer (or whoever
   covers them, ADR 061) the doer, else the manager. Test Company's file 39 was unchanged
   (the GM did the pest control; since ADR 074 its Executive Housekeeper does it); the Passport demo's GM answers for every job, each done by
   the head it belongs to.

## Consequences

- No access change: the doer's To do item is an ordinary job-role task; handing on uses the
  existing task and Compliance grants.
- Licences keep one role, the one that renews; renewals can be handed on like jobs.
- Pinned by `packages/db/src/compliance-doer.db.test.ts`, the Passport load test (re-import
  moves the reminder) and `apps/web/e2e/compliance.spec.ts`.
