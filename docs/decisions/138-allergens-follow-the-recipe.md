# ADR 138: Allergens follow the recipe

Status: accepted

Allergens were typed per item: file 10 for an opened pack's label (ADR 093) and file 19 for a
batch's label (ADR 076). Nothing linked the two. A prawn masala made with tagged prawns said
"No allergens declared" unless someone tagged the masala too, and a dish carried none at all.
Passport tagged 5 of its 80 items and none of its prep items, so nearly every label was empty.

- **One list, the same for every customer:** FSSAI's nine (Labelling & Display Regulations
  2020: cereals with gluten, crustaceans, milk, egg, fish, peanuts, tree nuts, soy, sulphites),
  then the five more on the EU's list of 14 (celery, mustard, sesame, lupin, molluscs). Guests
  from abroad ask about these, and squid and clams are molluscs, which FSSAI's list leaves out.
  `ALLERGENS` in `packages/domain/src/food-label.ts`; the database keeps the same words
  (`inv.allergen_words()`, a check on `inv.item.allergens` and `menu.menu_item.allergens`).
  Labels show all of them in the list's order.
- **Tagged once, carried by what is made from it:** a raw item is tagged in file 10. A prep
  item, a prep item inside it and a dish carry everything their recipe's items carry
  (`inv.allergens_of`, `inv.recipe_allergens`). A prep item's own tags (file 19) and a dish's
  (file 22's new optional `allergens`, for a garnish no recipe line names) add to these and
  never take any away. This is worked out when read, from the recipe of the day; a batch uses
  the recipe it was made with, on the day it was made (`inv.batch_allergens`). Nothing is
  copied, so a new tag or a recipe change shows everywhere at once.
- **Where it shows:** a batch's label and the Make list (`inv.batch_label`, `inv.batches`), a
  prep task (`ops.prep_task_recipe`) and a recipe's page, a dish's or a prep item's
  (`inv.my_recipes`, "Contains milk, cereals with gluten" under the name). Who sees them is
  unchanged: these functions decide, as before.
- **Hints, never tags:** an item's name says what it most likely carries ("Prawns, medium":
  crustaceans; "Poi": gluten; coconut milk is not milk, cashew feni is not a tree nut), in
  English, Hindi and Konkani (`allergenHints`). The dry run lists an item, prep item or dish
  whose name hints at something that neither its tags nor its recipe's items carry. These are
  warnings, never blockers, and nothing is ever tagged from a name: a wrong hint is ignored.
  The templates' starter milk and beer carry theirs.
- **Data:** Passport's file 10 now tags its fish, prawns, clams, squid, eggs, breads, flours,
  beers, vermouth, cashews and chocolate. Test Company adds ghee, curd, lager and vermouth,
  and the Solo Bar gets the `allergens` column with its dairy, eggs, wines and beers. All three
  load with no allergen warnings (`allergens.test.ts`).
- **Not done here:** an allergen list for the service team (servers cannot open recipes,
  ADR 123); editing an item's tags in the app (they come from the import, as before); "may
  contain" traces.
