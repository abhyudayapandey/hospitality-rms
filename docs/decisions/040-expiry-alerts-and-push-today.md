# 040 — Expiry alerts and "Push today"

Status: accepted · 2026-10-04

INV-12's banners and lists (ADR 033, 038) show what is expiring. The rest of INV-12: each
morning the teams whose recipes use an item about to expire hear about it, and servers see
"Push today" with the dishes that use it up.

## Decision

1. **About to expire** means a batch with stock left that expires by the end of tomorrow's
   business day (04:00 to 04:00, ADR 037, 046) and has not expired yet
   (`inv.expiring_soon`). Expired batches keep their own flow (report, discard, remake,
   TSK-6).
2. **The dishes that use it up** are those sold from the same store whose own recipe that
   day has the item as a line (`menu.dishes_using`). Not through another prep: selling a
   whisky sour uses up sour mix, not the syrup it was made from. Making more of that prep
   is the kitchen's call.
3. **The morning alert** (`ops.expiry_alerts`) runs in the 5-minute tasks job, after
   `ops.tasks_tick`. Once each business day, from 04:00 at the store (06:00 until ADR 046), the leads of the team
   that uses the store (`ops.leads(ops.team_of_store(store))`: the department head, else
   the outlet manager) get one notification per store: "Use first today: …" with each
   item, how much is left, its use-by time and its dishes. It links to the store's expiry
   list. A second run that day sends nothing (it looks for that day's notification).
4. **"Push today" on Home** (`menu.my_push_today`) shows the dishes at the person's own
   outlet, for its service teams (department type `service`: servers, bartenders,
   cashiers, hosts) and the people whose home is the outlet itself (its managers). The
   kitchen hears through the alert instead. `menu.push_today(outlet)` is open to anyone
   who works at the outlet (`ops.works_at`). Dish and item names only, never recipes or
   costs.
5. It is a rule, not AI: recipes and expiry. AI wording can come later on top of it.

## Consequences

No new table: the alert's "once a day" is the notification itself. A batch that expires
in two days shows tomorrow morning, not today, which keeps the list short.
