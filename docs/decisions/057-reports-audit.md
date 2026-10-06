# 057 — Reports audit: one meaning per figure, and what is behind it adds up

Status: accepted · 2026-10-06 (migration 20261112100000)

The owner found an Executive Chef's Home said "6 on shift today", while the People list behind
the same figure named 3 people. A full audit of the reports followed, for every kind of report
access in the test customers:

- a sweep, now `reports-reconcile.db.test.ts`;
- `apps/web/e2e/reports-sweep.spec.ts`;
- a reading of every `rpt` function.

The findings are in `docs/reports-audit.md`.

## Decision

1. **A shift is a person on a shift.**
   - "Shifts" counts one for each person assigned to a published shift. A shift nobody is
     on is an open slot, counted under Open slots.
   - Department today, Outlet today, the trends, Home's "On shift today", the people list
     behind them, the People report and My week now use the same count.
   - A shift belongs to the business day it starts (the 04:00 cut, ADR 046), everywhere. The
     People report used the roster date.
2. **Today counts what has come due.**
   - A task due later today is not "due", not "overdue" and not against "Tasks on time"
     until its time comes, unless it is already done.
   - The same applies to its list and its flagged readings. Past days are unchanged.
3. **The People report is about the people who belong to the place, wherever they worked,
   and its list is the same people.**
   - "On time" is a share of the shifts that have started, so a week's later shifts do not
     lower it.
   - Approved swaps are counted by the place's business day, not the UTC date.
4. **One business day everywhere.**
   - A store or outlet with no time zone of its own takes its outlet's (`ops.tz_of`), never UTC.
   - This applies to Cost of sales, its expired list, the cost parts and the count variance.
5. **Nothing a report leaves out is shown behind it.** Behind Cost of sales, the dishes are
   those of the stores the report covers for the person. A bar manager no longer sees the
   food dishes.
6. **Every figure is tested against what is behind it** (`reports-reconcile.db.test.ts`):
   - its list;
   - its trend's point for the same day;
   - the report it is drawn from, such as Outlets side by side against Outlet today.

   This runs for one person of every set of reports, at up to 3 places, today, yesterday and
   3 days ago. `REPORTS_ALL_USERS=1` runs it for every person. Every report screen is opened
   for one person of each set (`reports-sweep.spec.ts`).

7. **Home's "Today so far" figures each open their own trend.** A figure with none, such as
   "Not in yet", opens its report.

The stored daily tables are rebuilt by the migration, so past days read the same way.
