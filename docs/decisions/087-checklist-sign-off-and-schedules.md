# 087 — Checklists: a second signature, and the schedules hotels keep

Status: accepted · 2026-10-09 · migration 20261211100000

Passport Hotel's charts are signed twice: whoever does the round, then the person who checks
it (a supervisor, the department head, the chef). Some run on the 1st and 16th of the month or
on the 1st and 3rd Monday, and a weekly cleaning chart has different jobs on different days.
Part of the building-blocks plan (`docs/plans/building-blocks.md`, PR 2).

## Decision

1. **Sign-off is chosen per checklist at onboarding** (file 29 `sign_off`, the same on every row
   of a checklist): blank or `none` as before; `up`, the role one level up in the same
   department (the levels of ADR 060, worked out in the database by `ops.role_level`, the same
   rule as `levelOf`; a test keeps them equal), else the department head; `department_head`;
   or `role:CODE` at the outlet. Blank means none so every existing checklist stays as it is;
   `up` is what onboarding offers first. The app's checklist editor keeps it as set (ADR 085:
   configuration is the platform admin's).
2. **When the round is finished, the signer gets a To do item** (a task of kind `sign_off`), one
   person: the first by the rule, someone on duty now before someone who isn't, then the head of
   the department or the outlet's managers. The trigger on the round's status does it, so every
   way a round is finished asks.
3. **Signed off**: every step records who checked it (`checked_by`, `checked_at`) and the round
   who signed it off. **Sent back**: a note is required; the steps open again (their last values
   kept) for whoever did it, who is told; finishing again asks again.
4. **Whoever did any of the round never signs it** (`OWN_WORK`), even when a head hands the
   sign-off to them (rule 7's spirit). A sign-off is finished only by signing it off or sending
   it back.
5. **Schedules** gain `monthly 1,16 09:00` (a day past the month's end falls on its last day)
   and `nth Mon 1,3 10:00` (the 1st to 4th). **A step may run on some weekdays only** (file 29
   `days`; in the editor, `| Mon,Thu` at the end of the line); a round on a day with none of
   its steps is not made.
6. Like every task change since ADR 020, these go through `ops.*` functions that check who may,
   not through `wf.submit`: a sign-off is a check on work, not a request for something to
   change.

## Tests

`checklist-signoff.db.test.ts` (schedules and step days; one level up, the department head, a
named role, none; send back and redo; own work refused; another customer finds nothing),
`loader-checks.db.test.ts` (the levels equal the catalogue's), `tasks-view.test.ts`, and the e2e
`checklist-signoff.spec.ts` (the room attendant counts the linen, the supervisor sends it back
once, then signs it off).
