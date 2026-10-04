# 041 — Every report row and figure opens its trend

Status: accepted · 2026-10-04

Prospect feedback (3 Oct, RPT-12): tapping an item in a main report should open its
detail, with a trend by day, week or month, its sales and the breakdown of cost and profit
over time.

## Decision

1. **Three detail pages:**
   - **A dish** at an outlet (`/reports/dish`, `rpt.dish_trend`): sold, sales (what the
     POS took after discount, ADR 039; typed-in sales at the menu price), discount, recipe
     cost (as menu engineering works it out, ADR 028) and margin. It opens from Menu
     engineering, for the period chosen there.
   - **A stock item** at one store (`/reports/item`, `rpt.item_trend`): what came in
     (received, transferred in, made) and the value received from suppliers with the
     average price paid, what was used (sold by recipe, made into prep, other use) and
     wasted with their value, what was sent out, count differences and the stock left. It
     opens from Cost of sales (under a row's formula), Stock position, Purchasing and the
     central kitchen's batches.
   - **Any figure of a report** (`/reports/trend`, `rpt.measure_trend(report, place,
measure, grain, from, to, key)`): every figure on Outlet today, Department, Cost of
     sales, People and the central kitchen, the stock value on Stock position, each cell of
     Outlets side by side (the outlet's own figure), a supplier on Purchasing and an outlet
     on the central kitchen's dispatch (by the row's key). Figures of the moment (leave
     balances, days on hand, what is on the road) have none.
2. **Periods (owner feedback, 4 Oct):** the last 3, 6, 9 or 12 months, as Menu engineering
   offers, by week (the default: a narrow screen holds a year of weeks) or by month, from
   the Monday or the 1st the period starts in so the first point is whole. In business
   days at the place (ADR 037); 400 days at most per request. No day grain on screen.
3. **How a figure adds up over a period:** by day it is exactly what the report shows for
   that day (a test checks every measure of Outlet today and Department against the daily
   report). Over a week or month money, hours and counts add up; a stock value is the one
   at the end; a percentage is worked out again from the period's own totals (food cost
   over food sales), never an average of days. The outlet's and department's figures read
   the report tables (ADR 023) with yesterday and today worked out live, as the daily
   report does, so a year by week takes about a tenth of a second; the period reports
   (cost of sales, people, kitchen, purchasing) run the report itself once per period.
4. **A trend opens exactly where its report does** (`rpt.require(report, place)`), with
   the report's own rules: labour figures only for people who see labour on that report
   (`LABOUR_COST`), sales figures only with Menu and sales on, the dish only where its menu
   costs are seen. The Account Owner reads them, read-only, like every report.
5. **The chart is inline SVG**, a line (the default: a cost going up and down) or bars,
   chosen on the page; the figures are listed under it. No chart library.

## Consequences

People's department rows still open the names in that department, and short deliveries
and transfers on the road are single events, not trends. The dish and item pages read the ledger and the sales lines live,
which is fine at pilot volumes for a year at most; the report tables (ADR 023) can carry
them if it grows.
