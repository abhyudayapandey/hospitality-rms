# 042 — Cost as shares of the total cost; the lists behind each figure

Status: accepted · 2026-10-04 · migration 20261101100000

The owner's review of the reports (4 Oct): "People cost as % of sales doesn't make sense.
Everyone would be more interested in seeing their people cost vs. their prime cost as % of
total cost." And: "When someone clicks on Wastage, Stock value, any item of People, they
expect to see the items and people as well, not just graphs", each in its own section that
opens and closes, closed by default. "w/c" read as jargon.

## Decision

1. **People cost % and Materials % are shares of the total cost.** Total cost is raw
   materials plus people (what the reports called prime cost); People cost % is people ÷
   total, Materials % is materials ÷ total, so they add to 100. Prime cost stays in ₹ as
   "Total cost (prime cost)"; prime cost as a % of sales goes, and so does its target.
   Where the money went (Outlet today, Cost of sales and the trend) gives each part as a
   share of the total cost too: of materials plus people for those who see labour cost,
   of materials alone for everyone else. Food, drinks and wastage stay shares of sales:
   they compare a cost with what it earned. The same shares are on the trend, Outlets side
   by side (column "Materials %" replaces "Prime cost"), its CSV and Home's league card.
2. **Targets:** the People cost % target is now a share of the total cost, default 50%;
   `core.set_company_settings` refuses a prime target. The migration sets every company's
   People cost target to 50 and removes its prime target, because a target set against
   sales means nothing against cost; Account Owners set their own again in Admin →
   Settings.
3. **The lists behind a figure** (`rpt.bd_*`), for the report and place they open from,
   for one week or month:
   - `bd_dishes`: each dish's quantity, sales and recipe cost (Outlet today, Cost of sales);
   - `bd_wastage`: each item's quantity, value, reason, store and who recorded it (Outlet
     today, Department, Cost of sales);
   - `bd_stock`: each item held now, its quantity and value (Outlet today, Department,
     Stock position);
   - `bd_people`: each person's shifts, rostered and worked hours, late and no-shows, from
     the same sources as the report (Outlet today, Department, People);
   - `bd_tasks`: each person's due, done, on time, overdue and flagged tasks; tasks nobody
     has picked up yet show as "Not done yet (role)" (Outlet today, Department);
   - `bd_readings`: the readings flagged out of range, with the allowed range and who took
     them (Outlet today, Department).

   Each checks the report opens at the place (`rpt.require`), the same 93-day limit as the
   reports, and adds up to the report's own figure (a test checks every one). Names of
   people (people, tasks, readings) need the team at that place, `WORKERS` view or
   `REPORTS`; without it the page says the names are not shown, and the totals stay on the
   report. So the cost controller sees the outlet's late count, not who was late.

4. **On the trend page** the weeks or months are in a section, closed by default; tapping
   one picks it. Below, "What is behind it · Week of 28 Sep" has one closed section per
   list, its headline on the closed section ("17 due · 11.8% on time · 15 overdue"),
   biggest or worst first inside, each line with its share of the whole. The latest
   period with a figure is picked when none is. Dish and item pages put their period rows
   in the same closed section.
5. **"Week of 28 Sep"**, never "w/c", and "Sep", never "Sept".

## Consequences

A trend page makes up to three more small queries for the picked period. The stock list is
what is held now, not at the end of the picked week: the ledger can work that out later if
managers ask. Department and the central kitchen have no dish or cost list yet.
