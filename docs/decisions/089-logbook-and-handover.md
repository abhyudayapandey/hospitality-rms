# 089 — Logbook & handover: acknowledged handovers, logs that hold a while

Status: accepted · 2026-10-09 · migration 20261211130000

Passport keeps a front office logbook, a security logbook and a restaurant one: what the next
shift must know, and notes that stand for a day or a week. A handover nobody read is the usual
failure. Part of `docs/plans/building-blocks.md`, PR 2; the Logbook block (ADR 085).

## Decision

1. **One logbook per place** (a department or the outlet), written by whoever holds `LOGBOOK`
   modify there: staff, supervisors and heads at their own department (the `STAFF`,
   `SUPERVISOR` and `DEPARTMENT_HEAD` groups), the outlet's managers. Area managers read it.
2. **A handover** is for the next shift at any place of the same outlet (whoever is on shift
   there), a job role there, or a named person. It is a To do item (a `handover` task at that
   place, the usual task rules: the first on shift takes it, it is handed on, reminded and
   escalated like any task) until someone it is for **acknowledges** it ("I've read it"); that
   finishes it. The logbook shows each handover with who it is for and who acknowledged it
   when, or "Not acknowledged yet".
3. **A log** holds until a time (4 hours to a week); it shows in the logbook until then and can
   be taken down early. Entries are never edited or deleted.
4. The logbook lists the last two days' handovers and the logs still holding; older entries
   stay in the table (and the audit) for reports later.

## Tests

`logbook.db.test.ts` (to the next shift, a person, a job role; acknowledging; who may not
write, read or acknowledge; logs hold and are taken down; nothing while the block is off), and
the e2e `logbook.spec.ts`.
