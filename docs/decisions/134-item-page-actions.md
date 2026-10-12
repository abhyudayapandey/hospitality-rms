# ADR 134: An item's page asks for more

Status: accepted

An item's page showed what is on hand and up to 50 movements, and nothing to do about it. A
person who sees an item is low had to go back, find Ask for stock or Supply request, and find
the item again.

- The page reads top to bottom: the item and what is on hand, its five latest movements with
  "Show all N" (the same ledger, `?all=1`), its open requests, then one "Ask for more" button
  (the information first, its action after, ADR 051).
- Requests are the open stock requests and supply requests for this item into this store
  (`lib/item-requests.ts`): how much, from where, when, and where it is, each opening its
  request. RLS decides which the person sees.
- Ask for more follows the stock (ADR 115): if another store keeps the item
  (`inv.ask_items.source_id`) it opens Ask for stock, else, for whoever may raise a supply
  request there, the supply request. Neither for a derived place or without modify access.
- The form opens with the item first and marked (`?item=`): Ask for stock puts its store first
  and the item at the top with the cursor in it; the supply request shows it under "This item"
  above the usual groups. Nothing is filled in (ADR 053).
