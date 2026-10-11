# 116. A regular job repeats weekly or on a weekday of the month

Date: 2026-10-11. Status: accepted. Migration `20261218120000_compliance_repeat`.

## Context

Regular compliance jobs (ADR 069) repeated only every N months. Hotels also keep weekly and
fortnightly jobs (grease trap, fire panel test) and ones on a weekday of the month ("the 2nd
Tuesday", "the last Friday").

## Decision

1. A job repeats one way (`ops.compliance_item`, a check): `every_months` as before, or
   `every_weeks` (1 or 2) with `on_weekday`, or `nth` (1 to 4, or -1 for the last) with
   `on_weekday` (ISO, Monday 1).
2. **Next due** (`ops.compliance_next`): months from the day it was done, as before; a weekly
   job on its weekday after the week (or two) from when it was done or due, whichever is later;
   an nth-weekday job on the next such day after both.
3. **Reminders come as far ahead as the rule suits** (`ops.compliance_lead`): the day before a
   weekly job, 3 days before a fortnightly one, a week before an nth-weekday one, 14 days before
   a monthly one.
4. **Saving** goes through `ops.save_compliance_job` (the rule as JSON, every other check in
   `ops.save_compliance_item`); the app reads the rule with `ops.compliance_repeat`. The form
   taps: Months / Every week / Every 2 weeks / A day of the month, then the day.
5. **File 39** takes `every_months` or `repeat` in words ("every week on Monday", "every 2 weeks
   on Monday", "2nd Tuesday", "last Friday of each month"), one of the two
   (`packages/domain/src/repeat.ts` reads and says it).

## Tests

`compliance-repeat.db.test.ts`, `repeat.test.ts`, `loader-checks.db.test.ts`.
