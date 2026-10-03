# 031 — The league table, targets and company settings (R-4)

Status: accepted · 2026-10-03

`docs/reporting.md` step R-4, built in one change with PO-4 (ADR 032) at the user's request.

- **Migration** (forward-only): `20261024100000_league_tables_po_send`.
- **Deploy:** no stack change. Both test customers are re-imported for the suppliers' phones
  (ADR 032).

## The decisions (3 Oct)

1. **Default targets:** food 30%, drinks 22%, labour (people cost) 25%, prime cost 60%,
   wastage 2%, tasks done on time 90%.
2. **A figure is red only when it is worse than its target by more than 2 points.** Within
   2 points it is shown with its target and no colour.
3. **Export is CSV only.**
4. **Targets are set for the whole company.** Outlet overrides were proposed in the
   reporting plan; they wait until a customer needs them, since the pilot is one outlet and
   an override needs a table of its own with RLS.
5. **The league table covers at most 35 days**, the history the report tables keep.
6. **More company settings:** the menu engineering popularity threshold (ADR 028, 70%) and
   the overtime multiplier (ADR 030, 1×) move to settings.

## Company settings

- **Where.** `core.tenant.settings`, beside the modules (ADR 026): `targets`,
  `menu_popular_pct`, `overtime_multiplier`, `po_send_prices`. A setting not made is its
  default (`core.settings_defaults()`).
- **Who.** Anyone in the company reads them (`core.company_settings()`): they decide how
  figures are shown, not who sees them. Only the Account Owner changes them
  (`core.set_company_settings`, COMPANY_SETTINGS modify at the company), for their own
  company. The tenant's audit trigger records each change.
- **Checks.** Targets 0 to 100; popularity 10 to 100%; overtime 1× to 3×; prices on sent
  orders yes or no. Anything else, unknown keys included, is refused with
  `INVALID_SETTING` and nothing changes.
- **Screen.** Admin → Targets and settings. Other administrators see the values.

## Overtime and menu engineering

- **Overtime** costs `rate × (hours + overtime hours × (multiplier − 1))` for hourly staff.
  Salaried pay is fixed and unchanged. The stored days follow at the nightly rebuild (35
  days), as with pay rates (ADR 030).
- **Menu engineering** reads the popularity threshold for the company instead of 0.7.

## The league table ("Outlets side by side")

- **Who opens it, where.** At a company, region or area, for whoever reads the outlets'
  sales there (DERIVED_SALES: the Area Manager) or holds REPORTS (the Account Owner), when
  two or more of its outlets are theirs to open. One outlet is no league, so the solo bar's
  owner does not get it. Like cost of sales, it needs the Menu and sales module. It is the
  first report on their list.
- **Rows.** Each outlet under the place that the person may open Outlet today for.
- **Columns.** Sales; food and drinks cost by the recipes; people cost and prime cost (all
  raw materials plus people) only where the person sees labour cost (ADR 030), and never
  for fewer than 3 paid people; wastage; tasks done on time. Each is the same figure as
  Outlet today, added up over the days of the period.
- **Sorting.** By any column, best first: the lowest cost, the highest sales or task score.
- **Each row** opens that outlet's Outlet today.

## Targets on the reports

Outlet today, Department today, Cost of sales and the league table show each percentage
with its target. Comparing with the same day last week stays. The targets are applied on
the screen (`lib/settings.ts`), not in the report functions: they are not secret, and the
same rule then holds everywhere.

## CSV downloads

`/reports/csv/<list>` returns one list of a report as a file:

- the league table;
- Cost of sales items;
- Stock position items;
- Purchasing price changes and suppliers;
- People by department;
- Central kitchen by outlet.

It reads through the same `rpt.*` function as the screen, as the signed-in person, so it
holds exactly what the screen shows. A place they may not open answers 403. A cell a
spreadsheet would run as a formula (`=`, `+`, `-`, `@` first) gets a leading apostrophe,
plain numbers excepted. The file starts with a byte-order mark so Excel reads ₹.

## Tests

- `settings.db.test.ts`: defaults; only the Account Owner, own company only, partial
  changes, audited; every bad value refused.
- `league.db.test.ts`: places for every user against the rule; expected shapes; refusals
  (place, other company, more than 35 days); rows and sales against Outlet today; labour
  and prime hidden without LABOUR_COST.
- `reports-access` and `reports-refusals`: the league for every user.
- `labour-reports.db.test.ts`: the overtime multiplier raises hourly cost only.
- `cost-reports.db.test.ts`: the popularity threshold from settings.
- Unit: targets (`settings.test.ts`), the league sort (`reports.test.ts`), CSV escaping
  (`csv.test.ts`).
- e2e (`league-po-send.spec.ts`): the area manager's league table, sort and CSV; a
  bartender refused; the owner's target turns a figure red.
