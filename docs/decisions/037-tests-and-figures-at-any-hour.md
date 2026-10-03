# 037 — Tests and "today" at any hour of the day

Status: accepted · 2026-10-04

Between 00:00 and 06:00 India time, 12 DB tests and one e2e test failed, on master too.
Three clocks were in play:

- the test customers count their days from **today in India** (the loader, file 00's
  timezone);
- the tests used `current_date` in **UTC**, a day behind between 00:00 and 05:30 IST;
- reports use the **business day**, which starts at 06:00 (ADR 023), so before 06:00 it is
  still yesterday's.

## Decisions

1. **DB test connections use India time** (`TimeZone=Asia/Kolkata` in
   `packages/db/test/helpers.ts`), so `current_date` in a test is the loader's today. The
   labour e2e test takes its day the same way.
2. **Tests that read the business day say so.** Stock position counts days of use up to the
   business day, so before 06:00 there is one day fewer: the test expects 7 days minus the
   gap between the calendar day and `rpt.today`. The test week's sales count from the load
   day, a calendar day.
3. **Stock position's "expiring within 3 days" counts from the store's calendar day**, like
   the Stock banners and lists (`inv.expiry_list`), not from the business day. Before this,
   the two disagreed between midnight and 06:00. Migration
   `20261028100000_expiring_calendar_day`.
4. **Cost of sales, Purchasing and the expired-stock lines use the business day too.** The
   pages end a period at the business day, but these functions cut their days at midnight,
   so between midnight and 06:00 a closing count, wastage or receipt just made fell after
   the period and showed nowhere. Their days now run 06:00 to 06:00 (`rpt.day_start`), like
   sales and labour in the report tables: a bar's count at 00:30 belongs to the night it
   closes. Sales for a date are posted at 23:59:59 that day, so they stay on it. Migration
   `20261029100000_cost_business_day`.

## Consequences

CI and local runs pass at any hour. In production, Stock position's expiring value matches
the banners at night, and anything done between midnight and 06:00 shows in Cost of sales,
Purchasing and the expired-stock lines under the night before, not the next day.
