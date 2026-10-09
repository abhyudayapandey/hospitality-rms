# 091 — Utilities: meters, a daily reading round, and what was used

Status: accepted · 2026-10-09 · migration 20261211150000

Passport keeps a utility tracker: electricity, gas, water and diesel read every morning, the
day's use worked out by hand and totalled by month. Part of `docs/plans/building-blocks.md`, PR
2; the Utilities block (ADR 085).

## Decision

1. **Meters sit at a place** (file 43): the outlet or a department, usually Engineering, so its
   head reads their use with the outlet's managers (`UTILITIES`). Each has a kind
   (electricity, gas, water, diesel, other), a unit, the job role that reads it and when.
2. **The reading is a checklist round** the loader keeps from file 43 (one per place, role and
   time; `METERS-...`), a number step per meter that names it. So it comes to the reader's To
   do list, is reminded and escalated like every round, and needs nothing new on the task
   page. Saving a meter's step keeps the reading (`ops.meter_reading`); saving again corrects
   it.
3. **Use** is a day's last reading less the last reading before it, by the business day where
   the meter is (ADR 057), and summed by month for the last year (`ops.utility_days`,
   `ops.utility_months`). A reading lower than the one before shows as a negative use, in red,
   to be checked.
4. **A checklist can belong to another block** (`ops.checklist_template.module`): the meter
   round is the Utilities block's, so it has no rounds while Utilities is off even when
   Checklists is on. Utilities needs Checklists. Audits use the same (ADR 095).

## Tests

`utilities.db.test.ts` (the round's steps, readings kept and corrected, use by day and month;
who reads it; no rounds while the block is off), and the e2e `utilities.spec.ts`.
