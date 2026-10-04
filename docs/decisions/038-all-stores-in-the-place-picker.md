# 038 — "All stores" is an option in the Place picker

Status: accepted · 2026-10-04

Home's expiry banners count batches at every store a person sees. Since #52 they opened the
expiry list for all of them, with a line "All your stores · only <store>" above it. Once a
person tapped "only <store>", the only way back to every store was Home and the banner
again.

## Decision

1. **A list that can span stores offers "All stores" as the first option of its Place
   picker**, above the stores, instead of a separate line or link. Choosing it adds
   `all=1` to the address and keeps the place; choosing a store drops it and remembers the
   store for that screen, as before (ADR 016). "All stores" is not remembered: opening the
   screen from the menu shows the remembered store.
2. **A count that covers every store opens its list with "All stores" chosen.** Home's
   "Items expiring within 3 days" and "Expired items" banners always do. The Stock
   screen's banners count one store and open that store.
3. With "All stores" chosen, each line names its store; tabs on the screen (Within 3 days,
   Expired) keep the choice.
4. **This is the pattern for every new list that can cover several stores or places**
   (for example the POS import, stock check and vendor bills): the option sits in the
   existing Place picker (`PlaceSwitcher`'s `all` prop, through `SupplyHeader`), labelled
   for what it covers ("All stores", "All outlets").

The picker shows only what the person may see; "All stores" adds nothing to it. The list
behind it is the same RLS-scoped read (`inv.expiry_list`), so there is no access change.

## Consequences

The expiry lists switch between all stores and one store in one tap, either way. The
`ExpiryCounts` on Home no longer carry a store. The expiry list was the only screen with
the old "All your stores · only …" line.
