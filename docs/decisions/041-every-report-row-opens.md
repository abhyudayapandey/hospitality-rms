# 041 — Every report row opens its trend

Status: accepted · 2026-10-04

Prospect feedback (3 Oct, RPT-12): tapping an item in a main report should open its
detail, with a trend by day, week or month, its sales and the breakdown of cost and profit
over time.

## Decision

1. **Two detail pages**, one per kind of row:
   - **A dish** at an outlet (`/reports/dish`, `rpt.dish_trend`): sold, sales (what the
     POS took after discount, ADR 039; typed-in sales at the menu price), discount, recipe
     cost (as menu engineering works it out, ADR 028) and margin. It opens from Menu
     engineering.
   - **A stock item** at one store (`/reports/item`, `rpt.item_trend`): what came in
     (received, transferred in, made) and the value received from suppliers with the
     average price paid, what was used (sold by recipe, made into prep, other use) and
     wasted with their value, what was sent out, count differences and the stock left. It
     opens from Cost of sales (under a row's formula), Stock position and Purchasing.
2. **Periods:** the last 14 days, 13 weeks (from a Monday) or 12 months (from the 1st),
   in business days at the place (ADR 037). A year at most per request.
3. **A trend opens exactly where its report does** (`rpt.require('menu_engineering', …)`,
   `rpt.require('stock_position', store)`), and the dish must be sold from a store whose
   menu costs the person sees. The Account Owner reads them, read-only, like every report.
4. **The chart is inline SVG** (stacked bars: cost and margin; used and wasted), with every
   figure listed under it. No chart library.

## Consequences

The outlet flash and league rows already open an outlet's day; the People and labour
reports have no per-item rows. The trend pages read the ledger and the sales lines live,
which is fine at pilot volumes for a year at most; the report tables (ADR 023) can carry
them if it grows.
