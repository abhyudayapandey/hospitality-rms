# 046: The business day runs 04:00 to 04:00

Status: accepted · 4 Oct 2026 · replaces the 06:00 start in ADR 023 and 037

## Context

Every report counts by business day, so a bar's night belongs to the day it began
(ADR 023). We chose 06:00 as the cut-off. Bars close by 4 am, and no outlet opens before
4 am, so 04:00 is the quietest hour. At 06:00, early kitchens already working a morning
shift were still counted in yesterday.

## Decision

- The business day is **04:00 to 04:00 local time** at every place, in every report, the
  Today home, the cost pages, the offline-wastage dates, the morning expiry alert and the
  report tables.
- One migration changes the two functions every other function uses
  (`rpt.business_date`, `rpt.day_start`); nothing else hard-codes the hour.
- **An item expires on a date, not at a time of day.** A batch's use-by is the date of
  its expiry time in the business day, and it is good until that day ends: made at 10:00
  with a 24 hour shelf life, it is still good at 03:00 the next night and expired from
  04:00. Before, "expired" meant the exact minute, so a batch showed "Expired" on its own
  use-by date, and the lists showed a date only. `inv.expiry_at` gives the last instant of
  the use-by day and `inv.batch_rows` returns it, so the banners, lists, Stock position,
  expiry task and morning alert all agree. "Within 3 days" now counts business days too
  (ADR 037 counted calendar days). Nothing stored changes.

## Consequences

- Rows already stored in the report tables (`rpt.*_day`) still have the 06:00 boundary
  for days before today. The nightly job rebuilds the last 35 days with the new one;
  older days keep the old figures (a few hours of a night move between two days).
- Between 04:00 and 06:00 the figures, Home and "today" move on two hours earlier. The
  morning expiry alert goes out from 04:00 at the store, so the leads get it earlier.
- Tests that pin the cut-off (`reports`, `cost-reports`, `production-sales`,
  `item-trends`, `tasks`) use 04:00.
